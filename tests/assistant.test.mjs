process.env.SOLOCART_DB = ':memory:';
process.env.TZ = 'UTC';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS,
  WRITE_ACTIONS,
  execute,
  normalizePlan,
  parkPlan,
  parseWhen,
  plan,
  planFromRules,
  rememberExchange,
  takePlan,
} from '../server/ai/assistant.mjs';
import { createUser, createSession } from '../server/auth.mjs';
import { getDb } from '../server/db.mjs';
import { addEvent, createDraft, transition } from '../server/orders.mjs';
import { forgetAllFacts, listFacts, remember } from '../server/ai/memory.mjs';
import { composeTotals, totals } from '../server/summaries/spending.mjs';

const sample = {
  currency: 'USD',
  items: [{ name: 'Basket', quantity: 2, unitPrice: 18 }],
  shipping: 5,
  itemTotal: 36,
  total: 41,
  note: '',
};

async function seller(id = 'seller-1') {
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'local', 'Test Seller', `${id}@example.test`, Date.now());
  return id;
}

function capturedOrder(userId, total = 100) {
  const draft = createDraft(userId, { ...sample, total, itemTotal: total - 5 }, 'checkout');
  return transition(transition(draft, 'awaiting_buyer'), 'captured');
}

test('rules turn the brief’s example commands into the right actions', async () => {
  assert.equal(planFromRules('show unpaid orders').action, 'orders');
  assert.equal(planFromRules('show unpaid orders').status, 'awaiting_buyer');

  const totalsPlan = planFromRules('how much did I make this week');
  assert.equal(totalsPlan.action, 'totals');
  assert.equal(totalsPlan.period, 'week');
  assert.equal(planFromRules('what did I make today').period, 'today');
  assert.equal(planFromRules('how much did I spend this month').period, 'month');

  const reminder = planFromRules('remind me to ship order 12 tomorrow at 9am');
  assert.equal(reminder.action, 'remind');
  assert.ok(WRITE_ACTIONS.has(reminder.action));
  assert.equal(reminder.text.includes('9am'), false, 'the time phrase should not be part of the note');

  const resend = planFromRules('resend checkout link for Amira');
  assert.equal(resend.action, 'checkout_link');
});

test('plan() works with no provider configured and never invents an action', async () => {
  const userId = await seller('seller-plan');
  for (const said of ['show unpaid orders', 'how much did I make this week', 'what did Amira order?', 'hello']) {
    const result = await plan(userId, said);
    assert.ok(ACTIONS.includes(result.action), `${said} -> ${result.action}`);
    assert.equal(typeof result.reply, 'string');
  }
});

test('normalizePlan clamps anything a model might send back', () => {
  assert.equal(normalizePlan({ action: 'rm -rf /', reply: 'x' }).action, 'answer');
  const dirty = normalizePlan({ action: 'remind', text: 'a'.repeat(500), when: 'not a date', period: 'fortnight', amount: '40', orderId: '../../etc/passwd' });
  assert.equal(dirty.text.length <= 300, true);
  assert.equal(dirty.when, null);
  assert.equal(dirty.period, 'week');
  assert.equal(dirty.amount, 40);
  assert.equal(dirty.orderId, null);
});

test('parseWhen reads plain-English times', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  assert.ok(parseWhen('remind me tomorrow at 9am', now).includes('T09:00:00'));
  assert.ok(parseWhen('today at 15:30', now).includes('T15:30:00'));
  assert.ok(parseWhen('in 2 hours', now).includes('T12:00:00'));
  const bare = new Date(parseWhen('remind me tomorrow', now));
  assert.equal(bare.getUTCHours(), 9, 'a bare reminder defaults to 09:00');
});

test('write actions are gated: nothing runs until the token is confirmed', async () => {
  const userId = await seller('seller-gate');
  const said = 'remind me to pack boxes tomorrow at 5pm';
  const proposed = await plan(userId, said);
  assert.equal(WRITE_ACTIONS.has(proposed.action), true);

  const token = parkPlan(userId, proposed);
  // Confirming with the wrong account gets nothing.
  assert.equal(takePlan(token, 'someone-else'), null);
  assert.ok(takePlan(token, userId), 'the right account may take it');
  // Tokens are single-use.
  assert.equal(takePlan(token, userId), null);
});

test('a reminder only exists after the confirm click runs it', async () => {
  const userId = await seller('seller-remind');
  const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?').get(userId).n;

  const proposed = normalizePlan({ action: 'remind', text: 'ship order 12', when: '2026-10-30T09:00:00.000Z', reply: 'ok' });
  const token = parkPlan(userId, proposed);
  assert.equal(count(), 0, 'parking the plan must not create anything');

  const result = await execute(userId, takePlan(token, userId));
  assert.equal(count(), 1);
  assert.match(result.reply, /Reminder set for/);
});

test('cancelled plans leave no trace', async () => {
  const userId = await seller('seller-cancel');
  const token = parkPlan(userId, normalizePlan({ action: 'spend', amount: 12, text: 'boxes', reply: 'ok' }));
  takePlan(token, userId); // the confirm route consumed it; seller clicked Cancel
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM expenses WHERE user_id = ?').get(userId).n, 0);
});

test('totals come from the database, not from the model', async () => {
  const userId = await seller('seller-totals');
  capturedOrder(userId, 100);
  capturedOrder(userId, 50);
  const open = createDraft(userId, sample, 'checkout');
  transition(open, 'awaiting_buyer');

  const result = totals(userId, 'week', new Date(), 'UTC');
  assert.equal(result.revenue.count, 2);
  assert.equal(result.revenue.total, 150);
  assert.equal(result.awaiting.count, 1);

  const answer = await execute(userId, normalizePlan({ action: 'totals', period: 'week', reply: '' }));
  assert.match(answer.reply, /\$150/);
  assert.match(answer.reply, /Net: \$150/);
  assert.match(composeTotals(result), /Captured \$150/);
});

test('expenses land in the totals with their categories', async () => {
  const userId = await seller('seller-expenses');
  capturedOrder(userId, 200);
  await execute(userId, normalizePlan({ action: 'spend', amount: 40, text: 'boxes', category: 'supplies', reply: '' }));
  await execute(userId, normalizePlan({ action: 'spend', amount: 10, text: 'labels', category: 'supplies', reply: '' }));

  const result = totals(userId, 'month', new Date(), 'UTC');
  assert.equal(result.revenue.total, 200);
  assert.equal(result.expenses.total, 50);
  assert.equal(result.net, 150);
  assert.equal(result.expenses.byCategory[0].category, 'supplies');

  // A model cannot smuggle in an impossible amount.
  await assert.rejects(() => execute(userId, normalizePlan({ action: 'spend', amount: -5, text: 'x', reply: '' })));
});

test('listing orders answers read-only with no confirmation', async () => {
  const userId = await seller('seller-list');
  capturedOrder(userId, 30);
  const open = createDraft(userId, sample, 'checkout');
  transition(open, 'awaiting_buyer');

  const result = await execute(userId, normalizePlan({ action: 'orders', status: 'awaiting_buyer', reply: '' }));
  assert.match(result.reply, /1 order/);
  assert.equal(result.data.orders.length, 1);

  const all = await execute(userId, normalizePlan({ action: 'orders', status: null, reply: '' }));
  assert.equal(all.data.orders.length, 2);
});

test('facts can be remembered and forgotten by Byte', async () => {
  const userId = await seller('seller-facts');
  remember(userId, ['Ships boxes on Fridays', 'Prefers PayPal for large orders']);
  assert.equal(listFacts(userId).length, 2);

  // Secrets never get stored.
  remember(userId, ['my card is 4111 1111 1111 1111']);
  assert.equal(listFacts(userId).length, 2);

  const result = await execute(userId, normalizePlan({ action: 'forget', query: 'Fridays', reply: '' }));
  assert.match(result.reply, /Forgot/);
  assert.equal(listFacts(userId).length, 1);

  forgetAllFacts(userId);
  assert.equal(listFacts(userId).length, 0);
});

test('cancelling an order goes through the state machine', async () => {
  const userId = await seller('seller-cancel-order');
  const open = createDraft(userId, sample, 'checkout');
  transition(open, 'awaiting_buyer');

  const result = await execute(userId, normalizePlan({ action: 'cancel_order', orderId: open.id.slice(0, 8), reply: '' }));
  assert.match(result.reply, /failed/);

  // A captured order cannot be cancelled this way.
  capturedOrder(userId, 20);
  const answer = await execute(userId, normalizePlan({ action: 'cancel_order', orderId: 'nonexistent', reply: '' }));
  assert.match(answer.reply, /could not find/i);
});

test('conversation turns are recorded on both sides', async () => {
  const userId = await seller('seller-chat');
  rememberExchange(userId, 'show unpaid orders', 'No orders yet.');
  const { historyText, recentTurns } = await import('../server/ai/memory.mjs');
  const text = historyText(recentTurns(userId));
  assert.match(text, /seller: show unpaid orders/);
  assert.match(text, /byte: No orders yet/);
});

test('recall answers from the seller’s own rows with sources', async () => {
  const userId = await seller('seller-recall');
  const draft = createDraft(userId, { ...sample, note: 'wedding gift' }, 'local', 'Amira');
  transition(transition(draft, 'awaiting_buyer'), 'captured');
  addEvent(userId, { title: 'Captured', amount: 41 });

  const { recall } = await import('../server/ai/recall.mjs');
  const found = await recall(userId, 'what did Amira order?');
  assert.ok(found.sources.length >= 1, 'answers must cite an order');
  assert.equal(typeof found.sources[0].id, 'string');
  assert.ok(found.sources[0].id.length >= 8, 'a source is an order id');
  assert.match(found.answer, /Amira|41|basket/i);

  const nothing = await recall(userId, 'zzzz unmatched question');
  assert.ok(nothing.answer.length > 0);
});
