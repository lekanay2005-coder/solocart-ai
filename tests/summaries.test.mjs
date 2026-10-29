process.env.SOLOCART_DB = ':memory:';
process.env.TZ = 'UTC';
process.env.APP_TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

import { gather as briefGather, compose as composeBrief, todayIn } from '../server/summaries/brief.mjs';
import { gather as recapGather, compose as composeRecap } from '../server/summaries/recap.mjs';
import {
  streak,
  streakNote,
  saleDays,
  lifetimeRevenue,
  newMilestones,
  milestoneNote,
  MILESTONE_DOLLARS,
} from '../server/summaries/streaks.mjs';
import { createDraft, transition } from '../server/orders.mjs';
import { getDb } from '../server/db.mjs';

const NOW = new Date('2026-10-29T12:00:00Z');
const UTC = 'UTC';

function makeUser(id = 'u-sum') {
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'local', 'Test Seller', `${id}@example.test`, Date.now());
  return id;
}

const sample = {
  currency: 'USD',
  items: [{ name: 'Basket', quantity: 2, unitPrice: 18 }],
  shipping: 5,
  itemTotal: 36,
  total: 41,
  note: '',
};

function placeOrder(userId, status, { total = 41, updatedAt = Date.now(), createdAt = Date.now() } = {}) {
  const draft = createDraft(userId, { ...sample, total, itemTotal: total - 5 }, 'local');
  let order = draft;
  if (status !== 'draft') order = transition(transition(draft, 'awaiting_buyer'), 'captured');
  getDb().prepare('UPDATE orders SET updated_at = ?, created_at = ? WHERE id = ?').run(updatedAt, createdAt, order.id);
  if (status !== 'captured') {
    getDb().prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  }
  return order;
}

// --- the morning brief -----------------------------------------------------------------

test('the brief counts what awaits payment and what was captured yesterday', () => {
  const userId = makeUser('u-brief');
  placeOrder(userId, 'awaiting_buyer', { total: 41 });
  placeOrder(userId, 'awaiting_buyer', { total: 19 });
  // Captured yesterday (calendar day, UTC): inside 28 Oct, outside today.
  placeOrder(userId, 'captured', { total: 100, updatedAt: Date.parse('2026-10-28T09:00:00Z') });
  placeOrder(userId, 'captured', { total: 20, updatedAt: Date.parse('2026-10-28T18:30:00Z') });
  // Captured two days ago must NOT count as yesterday.
  placeOrder(userId, 'captured', { total: 55, updatedAt: Date.parse('2026-10-27T12:00:00Z') });
  // A draft and an offline confirmation waiting to be redeemed.
  placeOrder(userId, 'draft');
  getDb().prepare('INSERT INTO reminders (id, user_id, body, due_at, done, order_id, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)')
    .run('rem-1', userId, 'Ship the basket order', NOW.getTime() + 3 * 3600_000, Date.now());

  const parts = briefGather(NOW, UTC, userId);
  assert.equal(parts.awaiting.count, 2);
  assert.equal(parts.awaiting.total, 60);
  assert.equal(parts.capturedYesterday.count, 2);
  assert.equal(parts.capturedYesterday.total, 120, 'only the calendar yesterday');
  assert.equal(parts.drafts, 1);
  assert.equal(parts.reminders.length, 1);

  const text = composeBrief(parts, NOW, UTC);
  assert.match(text, /2 orders awaiting payment \(\$60\)/);
  assert.match(text, /\$120 captured yesterday across 2 orders/);
  assert.match(text, /Ship the basket order/);
  assert.ok(!text.includes('$55'), 'the older capture is not in the yesterday line');
});

test('the brief speaks plainly when the desk is empty', () => {
  const userId = makeUser('u-empty');
  const parts = briefGather(NOW, UTC, userId);
  const text = composeBrief(parts, NOW, UTC);
  assert.match(text, /No orders awaiting payment/);
  assert.match(text, /Nothing captured yesterday/);
  assert.equal(parts.offlinePending, 0);
  assert.equal(parts.streak, 0);
});

// --- streaks ---------------------------------------------------------------------------

test('a streak counts days in a row with a sale, tolerating this morning', () => {
  const userId = makeUser('u-streak');
  // Sales on 27, 28 and 29 October.
  placeOrder(userId, 'captured', { updatedAt: Date.parse('2026-10-27T10:00:00Z') });
  placeOrder(userId, 'captured', { updatedAt: Date.parse('2026-10-28T10:00:00Z') });
  placeOrder(userId, 'captured', { updatedAt: Date.parse('2026-10-29T09:00:00Z') });

  const days = saleDays(userId, UTC);
  assert.ok(days.includes('2026-10-27') && days.includes('2026-10-29'));
  assert.equal(streak(days, '2026-10-29'), 3, 'three days running');

  // Before today's first sale, yesterday still carries the streak.
  assert.equal(streak(['2026-10-27', '2026-10-28'], '2026-10-29'), 2);
  // A gap breaks it.
  assert.equal(streak(['2026-10-25', '2026-10-26'], '2026-10-29'), 0, 'two days off breaks it');

  assert.equal(streakNote(7), '7 days in a row with a sale.');
  assert.match(streakNote(30), /habit/);
  assert.match(streakNote(3), /3-day sale streak/);
  assert.equal(streak(['2026-10-29'], '2026-10-29'), 1);
});

test('milestones are counted from lifetime revenue and order count', () => {
  assert.deepEqual(newMilestones({ revenue: 0, count: 0 }, { revenue: 100, count: 1 }).map((m) => m.kind), ['dollars', 'orders']);
  assert.deepEqual(newMilestones({ revenue: 100, count: 1 }, { revenue: 501, count: 2 }).map((m) => m.value), [500]);
  assert.deepEqual(newMilestones({ revenue: 200, count: 5 }, { revenue: 300, count: 6 }), [], 'nothing crossed');
  assert.ok(MILESTONE_DOLLARS.includes(1000), 'first $1,000 is a milestone');

  const firstSale = newMilestones({ revenue: 0, count: 0 }, { revenue: 41, count: 1 })[0];
  assert.equal(firstSale.kind, 'orders');
  assert.equal(firstSale.value, 1);
  assert.match(milestoneNote(firstSale), /First sale captured/);
  assert.match(milestoneNote({ kind: 'dollars', value: 100 }), /First \$100 captured/);
});

test('lifetime revenue counts captured and settled orders only', () => {
  const userId = makeUser('u-life');
  placeOrder(userId, 'captured', { total: 41 });
  placeOrder(userId, 'captured', { total: 60 });
  placeOrder(userId, 'draft', { total: 999 });
  placeOrder(userId, 'failed', { total: 500 });
  const { revenue, count } = lifetimeRevenue(userId);
  assert.equal(revenue, 101);
  assert.equal(count, 2);
});

// --- the weekly recap --------------------------------------------------------------------

test('the recap sums the last 7 days, best day and highlights', () => {
  const userId = makeUser('u-rec');
  placeOrder(userId, 'captured', { total: 120, updatedAt: Date.parse('2026-10-27T11:00:00Z') });
  placeOrder(userId, 'captured', { total: 80, updatedAt: Date.parse('2026-10-27T15:00:00Z') });
  placeOrder(userId, 'captured', { total: 250, updatedAt: Date.parse('2026-10-29T10:00:00Z') });
  // Outside the window: 8 days ago.
  placeOrder(userId, 'captured', { total: 999, updatedAt: Date.parse('2026-10-21T10:00:00Z') });
  // Never captured: no money, but it appears in the by-status view.
  placeOrder(userId, 'draft', { createdAt: Date.parse('2026-10-28T10:00:00Z') });

  const week = recapGather(NOW, UTC, userId);
  assert.equal(week.total, 450, 'only captured money inside the window');
  assert.equal(week.count, 3);
  assert.equal(week.bestDay.day, '2026-10-29', 'today\'s sale is the biggest single day');
  assert.equal(week.bestDay.total, 250);
  assert.equal(week.highlights[0].total, 250, 'highlights sorted by amount');
  assert.equal(week.highlights.length, 3);
  assert.ok(week.byStatus.some((entry) => entry.status === 'draft'));

  const text = composeRecap(week);
  assert.match(text, /\$450 captured across 3 orders/);
  assert.match(text, /Best day: 2026-10-29 \(\$250\)/);
  assert.match(text, /Worth another look/);
});

test('an empty week says so', () => {
  const userId = makeUser('u-rec-empty');
  const week = recapGather(NOW, UTC, userId);
  assert.equal(week.total, 0);
  assert.match(composeRecap(week), /nothing captured in the last 7 days/);
});
