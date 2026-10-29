/**
 * Browser half of the Morrow protocol port — the *issuing* side, plus the
 * read/verify helpers the buyer page needs.
 *
 * Mirrors `server/offline/protocol.mjs` exactly: same canonical field order,
 * same `JSON.stringify` signed-message construction, same base64 Ed25519
 * signatures. It lives here (rather than being imported from the server)
 * because the whole point of the offline flow is that this code signs with
 * zero connectivity. `tests/offline.test.mjs` imports BOTH files and proves
 * they interoperate, so the duplication cannot silently drift.
 *
 * Uses only Web APIs (globalThis.crypto, TextEncoder, atob/btoa) plus the
 * vendored noble libraries, so it runs in any browser and in Node tests.
 */
import { ed25519 } from '../vendor/noble/curves/ed25519.js';
import { sha256 } from '../vendor/noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '../vendor/noble/hashes/utils.js';

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

export function randomId(prefix) {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

export function generateDeviceKeys() {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

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

// --- payment request reads -------------------------------------------------------

export function verifyPaymentRequest(request, now = Date.now()) {
  if (!request || typeof request !== 'object') return false;
  const { checksum, ...base } = request;
  if (request.version !== 1 || request.type !== 'payment.request') return false;
  if (typeof request.expiresAt !== 'number' || request.expiresAt <= now) return false;
  return checksum === digest(JSON.stringify(base));
}

export const serializeRequest = (request) => b64encode(JSON.stringify(request));
export const deserializeRequest = (payload) => JSON.parse(b64decode(payload));

// --- canonical field order (verbatim from Morrow; keep in lockstep) -------------

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

// --- payment confirmation (issuing) ----------------------------------------------

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

// --- self-check (the same proof a receiving device runs) ------------------------

export function verifyOfflineAuthorization(auth, expectedRequestId) {
  if (!auth || typeof auth !== 'object' || auth.version !== 1 || auth.type !== 'reserve.authorization') {
    return { valid: false, reason: 'Unrecognized authorization format.' };
  }
  if (auth.recipientRequestId !== expectedRequestId) {
    return { valid: false, reason: 'This authorization was not issued for this request.' };
  }
  if (!verifyCanonical(authFields(auth), auth.signature, auth.issuerPublicKey)) {
    return { valid: false, reason: 'Signature does not match — the authorization was altered or forged.' };
  }
  return { valid: true };
}

export function verifyPaymentConfirmation(confirmation, expectedRequest) {
  if (!confirmation || typeof confirmation !== 'object' || confirmation.version !== 1 || confirmation.type !== 'payment.confirmation') {
    return { valid: false, reason: 'Unrecognized confirmation format.' };
  }
  if (confirmation.requestId !== expectedRequest.id) {
    return { valid: false, reason: 'This confirmation is for a different request.' };
  }
  if (confirmation.amountMinor !== expectedRequest.amountMinor || confirmation.currency !== expectedRequest.currency) {
    return { valid: false, reason: 'The confirmed amount does not match this request.' };
  }
  if (!verifyCanonical(confirmationFields(confirmation), confirmation.signature, confirmation.signerPublicKey)) {
    return { valid: false, reason: 'Signature does not match — the confirmation was altered or forged.' };
  }
  const auth = confirmation.offlineAuthorization;
  if (auth && (auth.amountMinor !== confirmation.amountMinor || auth.currency !== confirmation.currency)) {
    return { valid: false, reason: 'The offline authorization amount does not match the confirmation.' };
  }
  if (auth) return verifyOfflineAuthorization(auth, expectedRequest.id);
  return { valid: true };
}
