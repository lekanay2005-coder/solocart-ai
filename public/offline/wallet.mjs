/**
 * The buyer's device: Ed25519 keypair + "Morrow Reserve" — pre-authorized
 * offline spending power. Port of `_sources/morrow/src/lib/{deviceKeys,reserve}.ts`
 * with AsyncStorage swapped for an injectable storage object (localStorage in
 * the browser, a Map shim in tests).
 *
 * This is the *issuing* side only. Nothing here talks to the network — the
 * whole point is that provisioning (while online) and spending (possibly with
 * zero connectivity) both happen on this device, and the server verifies the
 * signed results later. Chain rules, copied from Morrow:
 *
 *   * one ReserveAllowance, signed by this device the moment it is provisioned;
 *   * every spend carries `sequence = counter + 1`, `previousStateHash` of the
 *     prior state, and is bound to exactly one PaymentRequest.id;
 *   * spending more than remains throws before anything is signed;
 *   * a promise queue serializes read-modify-write, so a double tap cannot
 *     mint two authorizations sharing one sequence.
 *
 * Honest limits (see docs/OFFLINE_PAYMENTS.md, carried from Morrow's docs):
 * the allowance is a device-signed commitment, not custodial money; the key
 * lives in localStorage, not a secure enclave; and double-spend prevention
 * completes only at redemption, on the server.
 */
import { ed25519 } from '../vendor/noble/curves/ed25519.js';
import {
  b64FromBytes,
  bytesFromB64,
  createPaymentConfirmation,
  deserializeRequest,
  digest,
  generateDeviceKeys,
  randomId,
  serializeConfirmation,
  signCanonical,
  verifyPaymentConfirmation,
  verifyPaymentRequest,
} from './protocol.mjs';

const KEY_STORAGE = 'solocart.buyer-key.v1';
const RESERVE_STORAGE = 'solocart.reserve-state.v1';

// --- canonical field order (identical to protocol.mjs / Morrow) ----------------

function allowanceFields(a) {
  return { version: a.version, allowanceId: a.allowanceId, currency: a.currency, valueMinor: a.valueMinor, issuerPublicKey: a.issuerPublicKey, expiresAt: a.expiresAt, createdAt: a.createdAt };
}

function authFields(a) {
  return {
    version: a.version,
    type: a.type,
    allowanceId: a.allowanceId,
    sequence: a.sequence,
    recipientRequestId: a.recipientRequestId,
    recipientName: a.recipientName,
    amountMinor: a.amountMinor,
    currency: a.currency,
    remainingMinor: a.remainingMinor,
    previousStateHash: a.previousStateHash,
    nonce: a.nonce,
    timestamp: a.timestamp,
    issuerPublicKey: a.issuerPublicKey,
  };
}

/**
 * @param {{ getItem(k: string): string|null, setItem(k: string, v: string): void, removeItem(k: string): void }} [storage]
 */
export function createWallet(storage = globalThis.localStorage) {
  let cachedKeys = null;
  let spendQueue = Promise.resolve();

  function ensureDeviceKeys() {
    if (cachedKeys) return cachedKeys;
    const stored = storage.getItem(KEY_STORAGE);
    if (stored) {
      const privateKey = bytesFromB64(stored);
      cachedKeys = { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
      return cachedKeys;
    }
    const keys = generateDeviceKeys();
    storage.setItem(KEY_STORAGE, b64FromBytes(keys.privateKey));
    cachedKeys = keys;
    return cachedKeys;
  }

  const devicePublicKey = () => b64FromBytes(ensureDeviceKeys().publicKey);

  function readReserve(now) {
    const stored = storage.getItem(RESERVE_STORAGE);
    if (!stored) return null;
    let state;
    try {
      state = JSON.parse(stored);
    } catch {
      storage.removeItem(RESERVE_STORAGE);
      return null;
    }
    if (state.allowance.expiresAt <= now) {
      storage.removeItem(RESERVE_STORAGE);
      return null;
    }
    return state;
  }

  /** Online step: sign an allowance with this device's key. */
  function provisionReserve({ valueMinor, currency = 'USD', validForMs = 24 * 60 * 60 * 1000, now = Date.now() }) {
    if (!(valueMinor > 0)) throw new Error('Choose an amount above zero.');
    const keys = ensureDeviceKeys();
    const base = {
      version: 1,
      allowanceId: randomId('rsv'),
      currency,
      valueMinor: Math.round(valueMinor),
      issuerPublicKey: b64FromBytes(keys.publicKey),
      expiresAt: now + validForMs,
      createdAt: now,
    };
    const signature = signCanonical(keys.privateKey, allowanceFields(base));
    const state = {
      allowance: { ...base, issuerSignature: signature },
      spentMinor: 0,
      counter: 0,
      lastStateHash: digest(JSON.stringify(allowanceFields(base))),
    };
    storage.setItem(RESERVE_STORAGE, JSON.stringify(state));
    return state;
  }

  const clearReserve = () => storage.removeItem(RESERVE_STORAGE);

  /**
   * The synchronous core of a spend. Public entry points run it through the
   * queue so concurrent taps cannot share a sequence number.
   */
  function spendCore({ recipientRequestId, recipientName, amountMinor }, now) {
    const state = readReserve(now);
    if (!state) throw new Error('No active Reserve on this device — add funds while online first.');
    const remaining = state.allowance.valueMinor - state.spentMinor;
    if (amountMinor > remaining) throw new Error('This payment exceeds what remains in your Reserve.');
    const keys = ensureDeviceKeys();

    const sequence = state.counter + 1;
    const base = {
      version: 1,
      type: 'reserve.authorization',
      allowanceId: state.allowance.allowanceId,
      sequence,
      recipientRequestId,
      recipientName,
      amountMinor,
      currency: state.allowance.currency,
      remainingMinor: remaining - amountMinor,
      previousStateHash: state.lastStateHash,
      nonce: randomId('n'),
      timestamp: now,
      issuerPublicKey: state.allowance.issuerPublicKey,
    };
    const signature = signCanonical(keys.privateKey, authFields(base));
    const authorization = { ...base, signature };

    storage.setItem(RESERVE_STORAGE, JSON.stringify({
      allowance: state.allowance,
      spentMinor: state.spentMinor + amountMinor,
      counter: sequence,
      lastStateHash: digest(JSON.stringify(authFields(base))),
    }));
    return authorization;
  }

  /** Offline step: sign an OfflineAuthorization bound to this one request. */
  function spendFromReserve(input, now = Date.now()) {
    const next = spendQueue.then(() => spendCore(input, now), () => spendCore(input, now));
    spendQueue = next.catch(() => {});
    return next;
  }

  /**
   * The full buyer action: verify the request, spend from the Reserve, wrap
   * the authorization in a signed PaymentConfirmation, self-verify it (the
   * same check the seller's server will run), and return both.
   */
  function payFromReserve({ request, payerLabel }, now = Date.now()) {
    const next = spendQueue.then(run, run);
    spendQueue = next.catch(() => {});
    return next;

    async function run() {
      if (!verifyPaymentRequest(request, now)) {
        throw new Error('This payment request failed its integrity check or has expired.');
      }
      const authorization = spendCore({
        recipientRequestId: request.id,
        recipientName: request.merchant?.name || 'seller',
        amountMinor: request.amountMinor,
      }, now);
      const confirmation = createPaymentConfirmation(ensureDeviceKeys(), {
        requestId: request.id,
        amountMinor: request.amountMinor,
        currency: request.currency,
        payerLabel: String(payerLabel || 'Customer').slice(0, 40),
        settlementReference: `${authorization.allowanceId}:${authorization.sequence}`,
        offlineAuthorization: authorization,
      });
      const selfCheck = verifyPaymentConfirmation(confirmation, request);
      if (!selfCheck.valid) throw new Error(`Self-check failed: ${selfCheck.reason}`);
      return { confirmation, authorization, payload: serializeConfirmation(confirmation) };
    }
  }

  function reserveSummary(now = Date.now()) {
    const state = readReserve(now);
    if (!state) return { active: false };
    return {
      active: true,
      currency: state.allowance.currency,
      valueMinor: state.allowance.valueMinor,
      spentMinor: state.spentMinor,
      remainingMinor: state.allowance.valueMinor - state.spentMinor,
      counter: state.counter,
      expiresAt: state.allowance.expiresAt,
      allowanceId: state.allowance.allowanceId,
    };
  }

  return { ensureDeviceKeys, devicePublicKey, provisionReserve, spendFromReserve, payFromReserve, clearReserve, reserveSummary };
}

export { deserializeRequest, serializeConfirmation, verifyPaymentConfirmation, verifyPaymentRequest } from './protocol.mjs';
