/**
 * Morrow's signed payment-request protocol, ported to plain ESM from its
 * `src/lib/{protocol,deviceKeys,confirmation,reserve}.ts` files (the original
 * source tree was removed in phase 6; the byte format it shared with this
 * server is pinned by `tests/fixtures/offline-vectors.json`, which
 * `tests/offline-vectors.test.mjs` verifies here and the mobile app verifies
 * in `apps/morrow-mobile/src/lib/vectors.test.ts`).
 * The wire format is unchanged — same field order, same `JSON.stringify` of a
 * fixed-order object as the signed message, same base64 Ed25519 signatures —
 * so a Morrow client and this server verify each other's messages byte for
 * byte (proved in tests/offline.test.mjs and, from phase 5, by the shared
 * test-vector file).
 *
 * What is cryptographically enforced here:
 *   * a PaymentRequest carries a SHA-256 checksum over its own body (Morrow's
 *     design: requests are integrity-protected, not signed);
 *   * a PaymentConfirmation is Ed25519-signed by the payer's device key and
 *     bound to one request id, amount and currency;
 *   * an OfflineAuthorization is Ed25519-signed, bound to one
 *     `recipientRequestId`, and chained to the previous authorization state
 *     hash with a monotonic sequence — verification needs no shared secret
 *     and no network call.
 *
 * What it does NOT prove (carried over from Morrow's own docs, see
 * docs/OFFLINE_PAYMENTS.md): possession of a device key, not a real identity;
 * `previousStateHash` continuity is checked by whoever holds the chain; and
 * double-spend prevention only completes at redemption, server-side, where
 * the ledger can see every authorization.
 *
 * This module is verification-first but also contains the issuing side
 * (createPaymentRequest / createPaymentConfirmation) so the server and the
 * shared test vectors can produce genuine messages.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// --- primitives ------------------------------------------------------------------

export function b64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function bytesFromB64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const b64encode = (text) => b64FromBytes(utf8ToBytes(text));
export const b64decode = (value) => new TextDecoder().decode(bytesFromB64(value));

export const digest = (value) => bytesToHex(sha256(utf8ToBytes(value)));

/** `req_` + 20 hex chars, exactly Morrow's shape (`randomId('req')`). */
export function randomId(prefix) {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

/** Fresh Ed25519 device keypair (browser wallet and tests). */
export function generateDeviceKeys() {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

/**
 * Signs `JSON.stringify(value)` where value is a fixed-order field object.
 * Same construction as Morrow's `signCanonical` — the field order functions
 * below are verbatim ports and MUST stay in lockstep with the client side.
 */
export function signCanonical(privateKey, value) {
  const message = new TextEncoder().encode(JSON.stringify(value));
  return b64FromBytes(ed25519.sign(message, privateKey));
}

export function verifyCanonical(value, signatureB64, publicKeyB64) {
  try {
    const message = new TextEncoder().encode(JSON.stringify(value));
    return ed25519.verify(bytesFromB64(signatureB64), message, bytesFromB64(publicKeyB64));
  } catch {
    return false;
  }
}

// --- payment request (integrity-protected, not signed) --------------------------

/**
 * Same base object and key order as Morrow's `createPaymentRequest`; only the
 * merchant fields and the expiry horizon come from the caller (Morrow hard-
 * coded its demo merchant and a 5-minute expiry).
 */
export function createPaymentRequest({ amountMinor, currency, note, merchant, expiresAt, now = Date.now() }) {
  const base = {
    version: 1,
    type: 'payment.request',
    id: randomId('req'),
    merchant,
    amountMinor,
    currency,
    note: String(note || '').trim() || 'Payment',
    nonce: randomId('n'),
    createdAt: now,
    expiresAt,
  };
  return { ...base, checksum: digest(JSON.stringify(base)) };
}

export function verifyPaymentRequest(request, now = Date.now()) {
  if (!request || typeof request !== 'object') return false;
  const { checksum, ...base } = request;
  if (request.version !== 1 || request.type !== 'payment.request') return false;
  if (typeof request.expiresAt !== 'number' || request.expiresAt <= now) return false;
  return checksum === digest(JSON.stringify(base));
}

export const serializeRequest = (request) => b64encode(JSON.stringify(request));
export const deserializeRequest = (payload) => JSON.parse(b64decode(payload));

// --- canonical field order (verbatim from Morrow) -------------------------------

export function allowanceFields(a) {
  return { version: a.version, allowanceId: a.allowanceId, currency: a.currency, valueMinor: a.valueMinor, issuerPublicKey: a.issuerPublicKey, expiresAt: a.expiresAt, createdAt: a.createdAt };
}

export function authFields(a) {
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

export function confirmationFields(c) {
  return {
    version: c.version,
    type: c.type,
    requestId: c.requestId,
    amountMinor: c.amountMinor,
    currency: c.currency,
    payerLabel: c.payerLabel,
    settlementReference: c.settlementReference,
    confirmedAt: c.confirmedAt,
    nonce: c.nonce,
    signerPublicKey: c.signerPublicKey,
  };
}

// --- payment confirmation (signed by the payer device) --------------------------

export function createPaymentConfirmation(keys, input) {
  const base = {
    version: 1,
    type: 'payment.confirmation',
    requestId: input.requestId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    payerLabel: input.payerLabel,
    settlementReference: input.settlementReference,
    confirmedAt: Date.now(),
    nonce: randomId('n'),
    signerPublicKey: b64FromBytes(keys.publicKey),
  };
  const signature = signCanonical(keys.privateKey, confirmationFields(base));
  return { ...base, signature, offlineAuthorization: input.offlineAuthorization };
}

export const serializeConfirmation = (confirmation) => b64encode(JSON.stringify(confirmation));

export function deserializeConfirmation(payload) {
  return JSON.parse(b64decode(payload));
}

// --- verification ----------------------------------------------------------------

/**
 * Verifies an OfflineAuthorization independent of any shared secret — only
 * the signature, the embedded issuer public key, and the recipient binding.
 * The double-spend hook (`wasRedeemed`) is supplied by the ledger; while
 * offline, a device can only run its own local guard (Morrow's limit).
 */
export function verifyOfflineAuthorization(auth, expectedRequestId, { wasRedeemed = async () => false } = {}) {
  if (!auth || typeof auth !== 'object' || auth.version !== 1 || auth.type !== 'reserve.authorization') {
    return { valid: false, reason: 'Unrecognized authorization format.' };
  }
  if (auth.recipientRequestId !== expectedRequestId) {
    return { valid: false, reason: 'This authorization was not issued for this request.' };
  }
  if (!verifyCanonical(authFields(auth), auth.signature, auth.issuerPublicKey)) {
    return { valid: false, reason: 'Signature does not match — the authorization was altered or forged.' };
  }
  return Promise.resolve(wasRedeemed(auth.allowanceId, auth.sequence)).then((redeemed) => {
    if (redeemed) return { valid: false, reason: 'This authorization has already been redeemed.' };
    return { valid: true };
  });
}

/**
 * Verifies a PaymentConfirmation against the specific request it should be
 * settling: right request, right amount and currency, genuine signature,
 * not already credited, and — when it carries an embedded OfflineAuthorization
 * — the authorization itself, including the replay guard. Ported from
 * Morrow's `verifyPaymentConfirmation`.
 */
export function verifyPaymentConfirmation(confirmation, expectedRequest, { wasProcessed = async () => false, wasRedeemed = async () => false } = {}) {
  if (!confirmation || typeof confirmation !== 'object' || confirmation.version !== 1 || confirmation.type !== 'payment.confirmation') {
    return Promise.resolve({ valid: false, reason: 'Unrecognized confirmation format.' });
  }
  if (confirmation.requestId !== expectedRequest.id) {
    return Promise.resolve({ valid: false, reason: 'This confirmation is for a different request.' });
  }
  if (confirmation.amountMinor !== expectedRequest.amountMinor || confirmation.currency !== expectedRequest.currency) {
    return Promise.resolve({ valid: false, reason: 'The confirmed amount does not match this request.' });
  }
  if (!verifyCanonical(confirmationFields(confirmation), confirmation.signature, confirmation.signerPublicKey)) {
    return Promise.resolve({ valid: false, reason: 'Signature does not match — the confirmation was altered or forged.' });
  }
  return Promise.resolve(wasProcessed(`confirmation:${confirmation.requestId}`)).then(async (processed) => {
    if (processed) return { valid: false, reason: 'A confirmation for this request has already been redeemed.' };
    const auth = confirmation.offlineAuthorization;
    if (auth) {
      if (auth.amountMinor !== confirmation.amountMinor || auth.currency !== confirmation.currency) {
        return { valid: false, reason: 'The offline authorization amount does not match the confirmation.' };
      }
      const authVerdict = await verifyOfflineAuthorization(auth, expectedRequest.id, { wasRedeemed });
      if (!authVerdict.valid) return authVerdict;
    }
    return { valid: true };
  });
}
