/**
 * Phase 5: verify the SAME shared fixture as the server test
 * (tests/offline-vectors.test.mjs) with the mobile implementation. The server
 * signed these bytes; if the mobile app verifies them — checksum, signatures,
 * serialized payloads — the two sides' wire formats agree byte for byte.
 *
 * Fixture path: apps/morrow-mobile/src/lib → up four levels to the repo root.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { Base64 } from 'js-base64';
import vectorsJson from '../../../../tests/fixtures/offline-vectors.json';
import { deserializeConfirmation, serializeConfirmation, verifyPaymentConfirmation } from './confirmation';
import { deserializeRequest, digest, serializeRequest, verifyPaymentRequest } from './protocol';
import { verifyOfflineAuthorization } from './reserve';
import type { OfflineAuthorization, PaymentConfirmation, PaymentRequest } from './types';

interface Vectors {
  deviceKeys: { seed: string; publicKey: string };
  request: PaymentRequest;
  requestPayload: string;
  authorization: OfflineAuthorization;
  confirmation: PaymentConfirmation;
  confirmationPayload: string;
}

const vectors = vectorsJson as unknown as Vectors;

describe('shared offline-payments vectors (server-signed, app-verified)', () => {
  it('derives the documented device keypair from the seed', () => {
    const seed = hexToBytes(vectors.deviceKeys.seed);
    expect(Base64.fromUint8Array(ed25519.getPublicKey(seed))).toBe(vectors.deviceKeys.publicKey);
  });

  it('reproduces the request checksum and payload byte for byte', async () => {
    const { checksum, ...base } = vectors.request;
    expect(await digest(JSON.stringify(base))).toBe(checksum);

    // The server serialized this payload; the app must produce the same bytes
    // (the merchant name holds UTF-8 bullets on purpose).
    expect(serializeRequest(vectors.request)).toBe(vectors.requestPayload);

    const roundTrip = deserializeRequest(vectors.requestPayload);
    expect(serializeRequest(roundTrip)).toBe(vectors.requestPayload);
    expect(await verifyPaymentRequest(roundTrip)).toBe(true);
    expect(await verifyPaymentRequest({ ...roundTrip, amountMinor: 1 })).toBe(false);
  });

  it('verifies the Reserve authorization the server signed', async () => {
    const verdict = await verifyOfflineAuthorization(vectors.authorization, vectors.request.id);
    expect(verdict.valid).toBe(true);

    const tampered = await verifyOfflineAuthorization(
      { ...vectors.authorization, amountMinor: 999999 },
      vectors.request.id,
    );
    expect(tampered.valid).toBe(false);
  });

  it('verifies the confirmation the server signed and round-trips its payload', async () => {
    expect(serializeConfirmation(vectors.confirmation)).toBe(vectors.confirmationPayload);
    const confirmation = deserializeConfirmation(vectors.confirmationPayload);
    expect(serializeConfirmation(confirmation)).toBe(vectors.confirmationPayload);

    const verdict = await verifyPaymentConfirmation(confirmation, vectors.request);
    expect(verdict.valid).toBe(true);

    const tampered = await verifyPaymentConfirmation({ ...confirmation, amountMinor: 1 }, vectors.request);
    expect(tampered.valid).toBe(false);
  });
});
