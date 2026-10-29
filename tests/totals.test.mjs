process.env.SOLOCART_DB = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeTotals, roundMoney, safeName, summarizeOrder, validateOrder } from '../server/orders.mjs';

test('roundMoney rounds to cents, including float noise', () => {
  assert.equal(roundMoney(19.999), 20);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney('4.005'), 4.01);
  // Non-numeric input stays NaN on purpose: validateOrder uses that to reject
  // a missing or malformed shipping value instead of silently treating it as $0.
  assert.ok(Number.isNaN(roundMoney(undefined)));
});

test('computeTotals adds line items and shipping', () => {
  const totals = computeTotals(
    [
      { quantity: 2, unitPrice: 18 },
      { quantity: 1, unitPrice: 4.5 },
    ],
    5,
  );
  assert.equal(totals.itemTotal, 40.5);
  assert.equal(totals.shipping, 5);
  assert.equal(totals.total, 45.5);
});

test('computeTotals never trusts fractional-cent unit prices', () => {
  const totals = computeTotals([{ quantity: 3, unitPrice: 0.1 }], 0);
  assert.equal(totals.itemTotal, 0.3);
  assert.equal(totals.total, 0.3);
});

test('summarizeOrder reports currency and totals together', () => {
  const order = summarizeOrder({ items: [{ name: 'Mug', quantity: 2, unitPrice: 14 }], shipping: 4, note: 'hi' });
  assert.equal(order.currency, 'USD');
  assert.equal(order.itemTotal, 28);
  assert.equal(order.total, 32);
  assert.equal(order.shipping, 4);
});

test('validateOrder accepts a real order', () => {
  const order = validateOrder({
    items: [{ name: 'Handwoven basket', quantity: 2, unitPrice: 18 }],
    shipping: 5,
  });
  assert.equal(order.total, 41);
  assert.equal(order.items[0].name, 'Handwoven basket');
});

test('validateOrder rejects bad quantities, prices and totals', () => {
  assert.throws(() => validateOrder({ items: [], shipping: 0 }), /valid item names/);
  assert.throws(() => validateOrder({ items: [{ name: 'x', quantity: 0, unitPrice: 5 }] }), /valid item names/);
  assert.throws(() => validateOrder({ items: [{ name: 'x', quantity: 1, unitPrice: -5 }] }), /valid item names/);
  assert.throws(() => validateOrder({ items: [{ name: 'x', quantity: 1, unitPrice: 5 }], shipping: -1 }), /Shipping must be/);
  assert.throws(() => validateOrder({ items: [{ name: 'x', quantity: 99, unitPrice: 10000 }], shipping: 0 }), /total must be/);
});

test('safeName strips anything that is not a letter, digit or punctuation we allow', () => {
  assert.equal(safeName('<script>alert(1)</script>'), 'scriptalert1script');
  assert.equal(safeName(''), 'Custom item');
  assert.equal(safeName('North & Pine mug').length <= 60, true);
});
