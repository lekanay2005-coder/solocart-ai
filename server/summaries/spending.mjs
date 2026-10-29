/**
 * Seller revenue and expense totals, ported from Butler's `spending.ts`.
 *
 * The rule that matters: **totals are added up here, in code, never by the
 * model.** Ask Byte may decide that the seller meant "this week", but the
 * arithmetic is SQL and JavaScript — so the answer is right even when the
 * model is wrong, and it works with no keys at all.
 *
 * Revenue comes from captured/settled orders; expenses are rows the seller
 * logs (through Ask Byte or the API).
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../db.mjs';
import { money, startOf, PERIOD_WORDS } from './periods.mjs';

export const EXPENSE_CATEGORIES = ['supplies', 'shipping', 'fees', 'software', 'other'];

/** @typedef {(typeof EXPENSE_CATEGORIES)[number]} Category */

export function category(value) {
  const lower = String(value || '').trim().toLowerCase();
  return EXPENSE_CATEGORIES.find((name) => name === lower) || 'other';
}

/** Logs one expense. Amounts are clamped to something a receipt could justify. */
export function recordExpense(userId, { amount, what, category: rawCategory, at = Date.now(), currency = 'USD' }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0 || value > 100000) {
    const error = new Error('An expense needs an amount between $0.01 and $100,000.');
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const id = randomUUID();
  getDb()
    .prepare('INSERT INTO expenses (id, user_id, amount, currency, what, category, spent_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, value, currency, String(what || 'Expense').replace(/[<>]/g, '').slice(0, 120), category(rawCategory), at);
  return { id, amount: value };
}

export function listExpenses(userId, since) {
  return getDb()
    .prepare('SELECT id, amount, currency, what, category, spent_at FROM expenses WHERE user_id = ? AND spent_at >= ? ORDER BY spent_at DESC')
    .all(userId, since.getTime())
    .map((row) => ({ id: row.id, amount: row.amount, currency: row.currency, what: row.what, category: row.category, spentAt: row.spent_at }));
}

/**
 * Everything for one period, computed here:
 * revenue (captured + settled orders), expenses, and the difference.
 */
export function totals(userId, period, now = new Date(), timeZone = 'UTC') {
  const from = startOf(period, now, timeZone);
  const fromMs = from.getTime();
  const nowMs = now.getTime();

  const revenue = getDb()
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
              FROM orders
              WHERE user_id = ? AND status IN ('captured', 'settled')
                AND updated_at >= ? AND updated_at <= ?`)
    .get(userId, fromMs, nowMs);

  const awaiting = getDb()
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
              FROM orders WHERE user_id = ? AND status = 'awaiting_buyer'
                AND created_at >= ? AND created_at <= ?`)
    .get(userId, fromMs, nowMs);

  const expenses = getDb()
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM expenses WHERE user_id = ? AND spent_at >= ? AND spent_at <= ?')
    .get(userId, fromMs, nowMs);

  const byCategory = getDb()
    .prepare('SELECT category, COALESCE(SUM(amount), 0) AS amount FROM expenses WHERE user_id = ? AND spent_at >= ? AND spent_at <= ? GROUP BY category ORDER BY amount DESC')
    .all(userId, fromMs, nowMs);

  const revenueValue = Math.round(revenue.amount * 100) / 100;
  const expenseValue = Math.round(expenses.amount * 100) / 100;
  return {
    period,
    from: from.toISOString(),
    revenue: { total: revenueValue, count: revenue.count },
    awaiting: { total: Math.round(awaiting.amount * 100) / 100, count: awaiting.count },
    expenses: { total: expenseValue, count: expenses.count, byCategory: byCategory.map((row) => ({ category: row.category, total: Math.round(row.amount * 100) / 100 })) },
    net: Math.round((revenueValue - expenseValue) * 100) / 100,
  };
}

/**
 * The same numbers as one plain sentence — the form Ask Byte reads out.
 * Every figure here came out of `totals()`, not out of a model.
 */
export function composeTotals(result) {
  const when = PERIOD_WORDS[result.period] || result.period;
  const lines = [];
  if (!result.revenue.count && !result.expenses.count && !result.awaiting.count) {
    return `No money moved ${when} — no captured orders and no expenses recorded.`;
  }
  if (result.revenue.count) {
    lines.push(`Captured ${money(result.revenue.total)} across ${result.revenue.count} order${result.revenue.count === 1 ? '' : 's'} ${when}.`);
  } else {
    lines.push(`Nothing captured ${when}.`);
  }
  if (result.awaiting.count) {
    lines.push(`${money(result.awaiting.total)} is still awaiting buyer approval in ${result.awaiting.count} open checkout${result.awaiting.count === 1 ? '' : 's'}.`);
  }
  if (result.expenses.count) {
    const split = result.expenses.byCategory.length > 1
      ? ` (${result.expenses.byCategory.map((entry) => `${entry.category} ${money(entry.total)}`).join(', ')})`
      : '';
    lines.push(`Expenses ${money(result.expenses.total)}${split}.`);
  }
  lines.push(`Net: ${money(result.net)}.`);
  return lines.join(' ');
}
