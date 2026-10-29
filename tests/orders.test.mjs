process.env.SOLOCART_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { canTransition, assertTransition, createDraft, getOrder, listOrders, transition, addEvent, listEvents, activitySummary } from '../server/orders.mjs';
import { getDb } from '../server/db.mjs';

const draft = {
  currency: 'USD',
  items: [{ name: 'Basket', quantity: 2, unitPrice: 18 }],
  shipping: 5,
  itemTotal: 36,
  total: 41,
  note: 'review me',
};

function makeUser(id = 'user-1') {
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'local', 'Test Seller', `${id}@example.test`, Date.now());
  return id;
}

test('the happy path: draft -> awaiting_buyer -> captured', () => {
  assert.equal(canTransition('draft', 'awaiting_buyer'), true);
  assert.equal(canTransition('awaiting_buyer', 'captured'), true);
  assert.doesNotThrow(() => assertTransition('draft', 'awaiting_buyer'));
  assert.doesNotThrow(() => assertTransition('awaiting_buyer', 'captured'));
});

test('illegal transitions are refused', () => {
  assert.equal(canTransition('captured', 'failed'), false);
  assert.equal(canTransition('draft', 'captured'), false);
  assert.throws(() => assertTransition('captured', 'failed'), (error) => error.status === 409);
  assert.throws(() => assertTransition('draft', 'captured'), (error) => error.status === 409);
  assert.throws(() => assertTransition('draft', 'made_up'), (error) => error.status === 400);
});

test('terminal statuses accept no further moves', () => {
  for (const status of ['captured', 'failed', 'expired', 'settled']) {
    assert.deepEqual(canTransition(status, 'draft'), false);
    assert.deepEqual(canTransition(status, 'awaiting_buyer'), false);
  }
});

test('transition writes status only when the stored status still matches', () => {
  const userId = makeUser('user-t1');
  const created = createDraft(userId, draft, 'local');
  assert.equal(created.status, 'draft');

  const moved = transition(created, 'awaiting_buyer', { paypalOrderId: 'PAYPAL-1', captureRequestId: 'req-1' });
  assert.equal(moved.status, 'awaiting_buyer');
  assert.equal(moved.paypalOrderId, 'PAYPAL-1');

  // A second, stale writer cannot move it again from the old status.
  assert.throws(() => transition(created, 'captured'), (error) => error.status === 409);

  const captured = transition(moved, 'captured');
  assert.equal(captured.status, 'captured');
});

test('orders are scoped to their owner', () => {
  const a = makeUser('user-a');
  const b = makeUser('user-b');
  createDraft(a, draft, 'local');
  assert.equal(listOrders(a).length, 1);
  assert.equal(listOrders(b).length, 0);
  assert.equal(listOrders(a)[0].total, 41);
});

test('the offline branch follows its own path', () => {
  const userId = makeUser('user-offline');
  const created = createDraft(userId, draft, 'offline');
  const pending = transition(created, 'paid_offline_pending');
  assert.equal(pending.status, 'paid_offline_pending');
  assert.throws(() => transition(pending, 'captured'), (error) => error.status === 409);
  assert.equal(transition(pending, 'settled').status, 'settled');
});

test('activity events keep their order and sum up in code', () => {
  const userId = makeUser('user-events');
  addEvent(userId, { title: 'First', amount: 10, at: 1000 });
  addEvent(userId, { title: 'Second', amount: null, at: 2000 });
  addEvent(userId, { title: 'Third', amount: 5.5, at: 3000 });
  const events = listEvents(userId);
  assert.equal(events.length, 3);
  assert.equal(events[0].title, 'Third'); // newest first
  assert.equal(typeof events[0].time, 'string');
  const summary = activitySummary(userId);
  assert.equal(summary.count, 3);
  assert.equal(summary.amount, 15.5);
});

test('expired awaiting-buyer orders are swept', async () => {
  const userId = makeUser('user-sweep');
  const created = createDraft(userId, draft, 'local');
  const awaiting = transition(created, 'awaiting_buyer', { expiresAt: Date.now() - 1000 });
  assert.equal(awaiting.status, 'awaiting_buyer');
  const { expireStaleOrders } = await import('../server/orders.mjs');
  assert.equal(expireStaleOrders(), 1);
  assert.equal(getOrder(userId, created.id).status, 'expired');
});
