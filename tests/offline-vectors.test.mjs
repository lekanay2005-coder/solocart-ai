/**
 * Phase 5: verify the shared offline-payments test vectors with the SERVER
 * implementation. The mobile app verifies the exact same file with its own
 * implementation (apps/morrow-mobile/src/lib/vectors.test.ts), so a green run
 * on both sides proves the two wire formats still agree byte for byte.
 *
 * Regenerate the fixture only when the wire format changes intentionally:
 *   node scripts/gen-offline-vectors.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  allowanceFields,
  authFields,
  b64FromBytes,
  confirmationFields,
  deserializeConfirmation,
  deserializeRequest,
  digest,
  serializeConfirmation,
  serializeRequest,
  signCanonical,
  verifyOfflineAuthorization,
  verifyPaymentConfirmation,
  verifyPaymentRequest,
} from '../server/offline/protocol.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/offline-vectors.json', import.meta.url), 'utf8'));
const NOW = 1760000001000; // inside the vector request's validity window

test('shared vectors: keys, payloads and signatures round-trip on the server', async () => {
  // The documented keypair derives from the recorded seed.
  const seed = Buffer.from(vectors.deviceKeys.seed, 'hex');
  assert.equal(b64FromBytes(ed25519.getPublicKey(new Uint8Array(seed))), vectors.deviceKeys.publicKey);

  // Serialization is byte-exact (the merchant name holds UTF-8 bullets on purpose).
  assert.equal(serializeRequest(vectors.request), vectors.requestPayload);
  assert.deepEqual(deserializeRequest(vectors.requestPayload), vectors.request);
  assert.equal(serializeConfirmation(vectors.confirmation), vectors.confirmationPayload);
  assert.deepEqual(deserializeConfirmation(vectors.confirmationPayload), vectors.confirmation);

  // Signing is deterministic, so both sides must reproduce the same bytes.
  assert.equal(
    b64FromBytes(ed25519.sign(new TextEncoder().encode(JSON.stringify(confirmationFields(vectors.confirmation))), new Uint8Array(seed))),
    vectors.confirmation.signature,
  );
  assert.equal(signCanonical(new Uint8Array(seed), authFields(vectors.authorization)), vectors.authorization.signature);
  assert.equal(signCanonical(new Uint8Array(seed), allowanceFields(vectors.allowance)), vectors.allowance.issuerSignature);
});

test('shared vectors: the request checksum verifies and tampering fails', () => {
  const { checksum, ...base } = vectors.request;
  assert.equal(digest(JSON.stringify(base)), checksum, 'checksum covers the request exactly');
  assert.equal(verifyPaymentRequest(vectors.request, NOW), true);
  assert.equal(verifyPaymentRequest({ ...vectors.request, amountMinor: 1 }, NOW), false, 'changed amount fails');
  assert.equal(verifyPaymentRequest(vectors.request, vectors.request.expiresAt + 1), false, 'expired request fails');
});

test('shared vectors: the Reserve authorization verifies and its guards reject', async () => {
  const verdict = await verifyOfflineAuthorization(vectors.authorization, vectors.request.id);
  assert.equal(verdict.valid, true, verdict.reason ?? '');

  const wrongRequest = await verifyOfflineAuthorization(vectors.authorization, 'req_someone_else');
  assert.equal(wrongRequest.valid, false);

  const tampered = await verifyOfflineAuthorization(
    { ...vectors.authorization, amountMinor: 999999 },
    vectors.request.id,
  );
  assert.equal(tampered.valid, false);

  const replayed = await verifyOfflineAuthorization(vectors.authorization, vectors.request.id, {
    wasRedeemed: async () => true,
  });
  assert.equal(replayed.valid, false, 'a redeemed authorization must not verify again');
});

test('shared vectors: the confirmation verifies against its request', async () => {
  const verdict = await verifyPaymentConfirmation(vectors.confirmation, vectors.request);
  assert.equal(verdict.valid, true, verdict.reason ?? '');

  const tampered = await verifyPaymentConfirmation(
    { ...vectors.confirmation, amountMinor: 1 },
    vectors.request,
  );
  assert.equal(tampered.valid, false);

  const alreadyProcessed = await verifyPaymentConfirmation(vectors.confirmation, vectors.request, {
    wasProcessed: async () => true,
  });
  assert.equal(alreadyProcessed.valid, false);
});
