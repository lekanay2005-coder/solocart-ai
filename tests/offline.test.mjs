process.env.SOLOCART_DB = ':memory:';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '../server/db.mjs';
import { createDraft, getOrder, listEvents } from '../server/orders.mjs';
import * as ledger from '../server/offline/ledger.mjs';
import * as serverProtocol from '../server/offline/protocol.mjs';
import { createWallet } from '../public/offline/wallet.mjs';

const draft = {
  currency: 'USD',
  items: [{ name: 'Basket', quantity: 2, unitPrice: 18 }],
  shipping: 5,
  itemTotal: 36,
  total: 41,
  note: 'review me',
};

let userCounter = 0;
function makeUser(name = 'Test Seller') {
  const id = `user-off-${++userCounter}`;
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'local', name, `${id}@example.test`, Date.now());
  return { id, name };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    snapshot: () => new Map(map),
    restore: (snapshot) => {
      map.clear();
      for (const [key, value] of snapshot) map.set(key, value);
    },
  };
}

/** The seller half: draft order -> issued signed request. */
function issue(user = makeUser()) {
  const order = createDraft(user.id, draft, 'local');
  const issued = ledger.issueRequest(user, order);
  return { user, order, issued, request: issued.request };
}

/** The buyer half: provision a Reserve and pay one request, offline. */
async function pay(request, { valueMinor = 10_000, payerLabel = 'Amira' } = {}) {
  const storage = memoryStorage();
  const wallet = createWallet(storage);
  wallet.provisionReserve({ valueMinor });
  const result = await wallet.payFromReserve({ request, payerLabel });
  return { wallet, storage, ...result };
}

// --- protocol interop ------------------------------------------------------------

test('the browser wallet and the server verify each other (same wire format)', async () => {
  const { request } = issue();
  const { confirmation, payload } = await pay(request);

  // Server verifies what the browser signed, from the serialized payload.
  const verdict = await serverProtocol.verifyPaymentConfirmation(
    serverProtocol.deserializeConfirmation(payload),
    request,
  );
  assert.deepEqual(verdict, { valid: true });

  // And the browser verifies a confirmation built by the server-side issuer.
  const keys = serverProtocol.generateDeviceKeys();
  const serverMade = serverProtocol.createPaymentConfirmation(keys, {
    requestId: request.id,
    amountMinor: request.amountMinor,
    currency: request.currency,
    payerLabel: 'server',
    settlementReference: 'vec',
    offlineAuthorization: confirmation.offlineAuthorization,
  });
  const { verifyPaymentConfirmation } = await import('../public/offline/protocol.mjs');
  const local = verifyPaymentConfirmation(serverMade, request);
  assert.equal(local.valid, true, local.reason);
});

test('a tampered request fails its checksum', async () => {
  const { request } = issue();
  const { verifyPaymentRequest, deserializeRequest, serializeRequest } = await import('../public/offline/protocol.mjs');
  const roundTripped = deserializeRequest(serializeRequest(request));
  assert.equal(verifyPaymentRequest(roundTripped), true);
  assert.equal(verifyPaymentRequest({ ...roundTripped, amountMinor: 1 }), false);
  assert.equal(verifyPaymentRequest({ ...roundTripped, merchant: { ...roundTripped.merchant, name: 'Evil' } }), false);
});

// --- the happy path --------------------------------------------------------------

test('two windows: issue -> pay -> confirm -> redeem settles the order', async () => {
  const { user, order, issued } = issue();
  assert.equal(issued.status, 'pending');
  assert.equal(issued.amountMinor, 4100);
  assert.ok(issued.payload.length > 0);
  assert.ok(issued.request.checksum);

  const { payload, confirmation } = await pay(issued.request);
  assert.equal(confirmation.offlineAuthorization.recipientRequestId, issued.requestId);

  const confirmed = await ledger.confirm({ requestId: issued.requestId, confirmationInput: payload });
  assert.equal(confirmed.requestId, issued.requestId);
  assert.equal(confirmed.userId, user.id);
  assert.equal(getOrder(user.id, order.id).status, 'paid_offline_pending');

  const redeemed = await ledger.redeem(user, issued.requestId);
  assert.equal(redeemed.requestId, issued.requestId);
  assert.match(redeemed.channel, /simulated/);
  assert.match(redeemed.notice, /simulated/i);

  const settled = getOrder(user.id, order.id);
  assert.equal(settled.status, 'settled');

  const events = listEvents(user.id).map((event) => event.title);
  assert.ok(events.includes('Offline payment redeemed'));
});

// --- replay and tamper rejection -------------------------------------------------

test('a confirmation is rejected when any signed field is altered', async () => {
  const { issued } = issue();
  const { confirmation } = await pay(issued.request);

  // A field the request comparison does not cover: only the signature can
  // catch this.
  const relabeled = structuredClone(confirmation);
  relabeled.payerLabel = 'Mallory';
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: relabeled }),
    (error) => error.status === 400 && /altered or forged/.test(error.message),
  );

  // The amount is compared against the server-issued request first.
  const raised = structuredClone(confirmation);
  raised.amountMinor = 999999;
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: raised }),
    (error) => error.status === 400 && /does not match/.test(error.message),
  );

  const reissued = structuredClone(confirmation);
  reissued.requestId = 'req_00000000000000000000';
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: reissued }),
    (error) => error.status === 400,
  );
});

test('a forged offline authorization is rejected even though the outer confirmation is genuine', async () => {
  const { issued } = issue();
  const { confirmation } = await pay(issued.request);

  // The offlineAuthorization travels unsigned inside the confirmation
  // (Morrow's design) — so the receiver must verify it separately.
  const forged = structuredClone(confirmation);
  forged.offlineAuthorization.amountMinor = 999999;
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: forged }),
    (error) => error.status === 400 && /does not match/.test(error.reason || error.message),
  );

  const resignedWrongBinding = structuredClone(confirmation);
  resignedWrongBinding.offlineAuthorization.remainingMinor = 0;
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: resignedWrongBinding }),
    (error) => error.status === 400 && /altered or forged/.test(error.message),
  );
});

test('an authorization bound to another request cannot confirm this one', async () => {
  const a = issue();
  const b = issue(a.user);
  const { confirmation, wallet } = await pay(a.request);

  // Re-sign the outer confirmation for request B while embedding A's
  // authorization — the binding check must catch it.
  const keys = wallet.ensureDeviceKeys();
  const misplaced = serverProtocol.createPaymentConfirmation(keys, {
    requestId: b.request.id,
    amountMinor: b.request.amountMinor,
    currency: b.request.currency,
    payerLabel: 'Amira',
    settlementReference: confirmation.settlementReference,
    offlineAuthorization: confirmation.offlineAuthorization,
  });
  await assert.rejects(
    ledger.confirm({ requestId: b.issued.requestId, confirmationInput: misplaced }),
    (error) => error.status === 400 && /not issued for this request/.test(error.message),
  );
});

test('a request can only be confirmed once and redeemed once', async () => {
  const { user, issued } = issue();
  const { payload } = await pay(issued.request);

  await ledger.confirm({ requestId: issued.requestId, confirmationInput: payload });
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: payload }),
    (error) => error.status === 409,
  );

  await ledger.redeem(user, issued.requestId);
  await assert.rejects(
    ledger.redeem(user, issued.requestId),
    (error) => error.status === 409 && error.code === 'already_redeemed',
  );
});

test('redeeming before any confirmation is refused', async () => {
  const { user, issued } = issue();
  await assert.rejects(
    ledger.redeem(user, issued.requestId),
    (error) => error.status === 409 && error.code === 'not_confirmed',
  );
});

test('an expired request cannot be confirmed', async () => {
  const { issued } = issue();
  getDb().prepare('UPDATE offline_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, issued.requestId);
  const { payload } = await pay(issued.request);
  await assert.rejects(
    ledger.confirm({ requestId: issued.requestId, confirmationInput: payload }),
    (error) => error.status === 410 && error.code === 'request_expired',
  );
});

// --- double-spend ----------------------------------------------------------------

test('spending more than the Reserve holds is refused before anything is signed', async () => {
  const { request } = issue();
  const storage = memoryStorage();
  const wallet = createWallet(storage);
  wallet.provisionReserve({ valueMinor: 1000 }); // less than the 4100 request
  await assert.rejects(
    wallet.payFromReserve({ request, payerLabel: 'Amira' }),
    /exceeds what remains/,
  );
});

test('a cloned device cannot redeem the same sequence twice, even on two requests', async () => {
  // Morrow's documented limit, caught at redemption: copy the device state,
  // pay two different requests with the same signed spend, and the server's
  // (allowanceId, sequence) ledger refuses the second redemption.
  const seller = makeUser();
  const a = issue(seller);
  const b = issue(seller);
  const aId = a.issued.requestId;
  const bId = b.issued.requestId;

  const storage = memoryStorage();
  const wallet = createWallet(storage);
  wallet.provisionReserve({ valueMinor: 10_000 });
  const pristine = storage.snapshot(); // the cloned device state

  const payA = await wallet.payFromReserve({ request: a.request, payerLabel: 'Amira' });
  storage.restore(pristine); // rewind the clone to the pre-spend state
  const payB = await wallet.payFromReserve({ request: b.request, payerLabel: 'Amira' });

  // Same allowance, same sequence, two different requests.
  assert.equal(payA.authorization.allowanceId, payB.authorization.allowanceId);
  assert.equal(payA.authorization.sequence, payB.authorization.sequence);

  // Both handoffs verify (each binds to its own request).
  await ledger.confirm({ requestId: aId, confirmationInput: payA.payload });
  await ledger.confirm({ requestId: bId, confirmationInput: payB.payload });

  // First redemption lands; the twin is refused.
  const first = await ledger.redeem(seller, aId);
  assert.match(first.channel, /offline-reserve/);
  await assert.rejects(
    ledger.redeem(seller, bId),
    (error) => error.status === 409 && /already been redeemed/.test(error.message),
  );
  assert.equal(getOrder(seller.id, b.order.id).status, 'paid_offline_pending'); // not settled
});

// --- scope -----------------------------------------------------------------------

test('offline requests are issued from draft orders only', async () => {
  const user = makeUser();
  const order = createDraft(user.id, draft, 'local');
  getDb().prepare("UPDATE orders SET status = 'awaiting_buyer' WHERE id = ?").run(order.id);
  assert.throws(
    () => ledger.issueRequest(user, getOrder(user.id, order.id)),
    (error) => error.status === 409,
  );
});

test('requests and redemptions are scoped to their owner', async () => {
  const owner = makeUser();
  const stranger = makeUser('Stranger');
  const order = createDraft(owner.id, draft, 'local');
  const issued = ledger.issueRequest(owner, order);
  const { payload } = await pay(issued.request);
  await ledger.confirm({ requestId: issued.requestId, confirmationInput: payload });
  await assert.rejects(
    ledger.redeem(stranger, issued.requestId),
    (error) => error.status === 404,
  );
  assert.equal(listEvents(stranger.id).length, 0);
});

test('the buyer page can read a shared request, and only that one', async () => {
  const { issued } = issue();
  const shared = ledger.findShare(issued.requestId);
  assert.equal(shared.status, 'pending');
  assert.equal(shared.request.id, issued.requestId);
  assert.equal(ledger.findShare('req_ffffffffffffffffffff'), null);
  assert.equal(ledger.findShare('not-a-request'), null);
});
