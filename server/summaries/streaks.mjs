/**
 * Streaks and milestones — the counting half of Butler's `streaks.ts`, without
 * its persona (SoloCart's voice) and counted against this desk's own data:
 * days in a row with a sale, and money thresholds crossed. Every number here
 * comes out of SQL, never out of a model.
 */
import { getDb } from '../db.mjs';
import { localIso } from './periods.mjs';

/** Dollar thresholds that earn a "moment". */
export const MILESTONE_DOLLARS = [100, 500, 1000, 2500, 5000, 10000];
/** Paid-order counts that earn a moment (the very first sale counts). */
export const MILESTONE_ORDERS = [1, 10, 25, 50, 100, 250];
const STREAKS = [3, 7, 14, 30, 60, 100, 365];

/**
 * Days in a row with at least one sale, ending today (or yesterday, so the
 * streak isn't "broken" in the morning before anything has sold). `days` are
 * local dates like 2026-10-20. Ported from Butler verbatim.
 */
export function streak(days, today) {
  const have = new Set(days);
  const back = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  let start = have.has(today) ? today : back(today, 1);
  let n = 0;
  while (have.has(start)) {
    n++;
    start = back(start, 1);
  }
  return n;
}

export const streakWorthCheering = (n) => STREAKS.includes(n);

export const milestoneDollars = (total) => (MILESTONE_DOLLARS.includes(total) ? total : null);

/** Local dates (in `timeZone`) with at least one captured/settled order, over the last year. */
export function saleDays(userId, timeZone) {
  const since = Date.now() - 400 * 86_400_000;
  const rows = getDb()
    .prepare("SELECT DISTINCT updated_at FROM orders WHERE user_id = ? AND status IN ('captured', 'settled') AND updated_at >= ?")
    .all(userId, since);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return rows.map((row) => formatter.format(new Date(row.updated_at)));
}

export const lifetimeRevenue = (userId) => {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS n FROM orders WHERE user_id = ? AND status IN ('captured', 'settled')")
    .get(userId);
  return { revenue: Math.round(row.amount * 100) / 100, count: row.n };
};

/**
 * The thresholds `after` has crossed that `before` hadn't — called around a
 * capture or redemption so the moment appears in activity the instant it is real.
 */
export function newMilestones(before, after) {
  const crossed = [];
  const dollars = MILESTONE_DOLLARS.find((t) => before.revenue < t && after.revenue >= t);
  if (dollars) crossed.push({ kind: 'dollars', value: dollars, note: dollars === MILESTONE_DOLLARS[0] ? `First $${dollars} captured` : `$${dollars.toLocaleString('en')} captured` });
  const orders = MILESTONE_ORDERS.find((t) => before.count < t && after.count >= t);
  if (orders) crossed.push({ kind: 'orders', value: orders, note: orders === 1 ? 'First sale captured' : `${orders} paid orders` });
  return crossed;
}

/** Plain sentences for a milestone the desk just reached. */
export function milestoneNote(milestone) {
  if (milestone.kind === 'dollars') {
    return milestone.value === MILESTONE_DOLLARS[0]
      ? 'First $100 captured — the shop is live.'
      : `$${milestone.value.toLocaleString('en')} lifetime captured.`;
  }
  return milestone.value === 1
    ? 'First sale captured.'
    : `${milestone.value} paid orders and counting.`;
}

export function streakNote(n) {
  if (n >= 30) return `${n} days in a row with a sale — that is a habit now.`;
  if (n >= 7) return `${n} days in a row with a sale.`;
  return `${n}-day sale streak. Sell tomorrow to keep it going.`;
}

/** Today's local date, like 2026-10-20. */
export const today = (now, timeZone) => localIso(now, timeZone).slice(0, 10);
