/**
 * The morning brief — AI-free, like Butler's, retargeted at the shop:
 * what awaits payment, what got captured yesterday, what needs redeeming,
 * what's due today. It's free, always works, and no model can get it wrong.
 */
import { getDb } from '../db.mjs';
import { endOfDay, localIso, money } from './periods.mjs';
import { streak, saleDays } from './streaks.mjs';

/** Today's date in `timeZone`, like 2026-10-20. */
export const todayIn = (now, timeZone) => localIso(now, timeZone).slice(0, 10);

/**
 * The brief's parts, all computed here: awaiting orders, money captured
 * yesterday (the calendar day, in the seller's own time zone), offline
 * confirmations waiting to be redeemed, drafts, reminders due today, streak.
 */
export function gather(now, timeZone, userId) {
  const todayStart = new Date(`${localIso(now, timeZone).slice(0, 10)}T00:00:00${localIso(now, timeZone).slice(19)}`);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const db = getDb();

  const awaiting = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE user_id = ? AND status = 'awaiting_buyer'")
    .get(userId);
  const captured = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE user_id = ? AND status IN ('captured', 'settled') AND updated_at >= ? AND updated_at < ?")
    .get(userId, yesterdayStart.getTime(), todayStart.getTime());
  const drafts = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'draft'")
    .get(userId);
  const offlinePending = db
    .prepare("SELECT COUNT(*) AS n FROM offline_requests WHERE user_id = ? AND status = 'confirmed'")
    .get(userId);
  const reminders = db
    .prepare('SELECT body, due_at FROM reminders WHERE user_id = ? AND done = 0 AND due_at > ? AND due_at <= ? ORDER BY due_at LIMIT 5')
    .all(userId, now.getTime(), endOfDay(now, timeZone).getTime());

  const day = todayIn(now, timeZone);
  return {
    awaiting: { count: awaiting.n, total: Math.round(awaiting.amount * 100) / 100 },
    capturedYesterday: { count: captured.n, total: Math.round(captured.amount * 100) / 100 },
    drafts: drafts.n,
    offlinePending: offlinePending.n,
    reminders: reminders.map((row) => ({ body: row.body, dueAt: row.due_at })),
    streak: streak(saleDays(userId, timeZone), day),
  };
}

/** The brief as short plain lines. Every figure came out of `gather()`. */
export function compose(parts, now, timeZone) {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  const hour = Number(localIso(now, timeZone).slice(11, 13));
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const lines = [`${hello}. Here is your ${day}:`, ''];
  if (parts.awaiting.count) {
    lines.push(`${parts.awaiting.count} order${parts.awaiting.count === 1 ? '' : 's'} awaiting payment (${money(parts.awaiting.total)}).`);
  } else {
    lines.push('No orders awaiting payment.');
  }
  if (parts.capturedYesterday.count) {
    lines.push(`${money(parts.capturedYesterday.total)} captured yesterday across ${parts.capturedYesterday.count} order${parts.capturedYesterday.count === 1 ? '' : 's'}.`);
  } else {
    lines.push('Nothing captured yesterday.');
  }
  if (parts.offlinePending) {
    lines.push(`${parts.offlinePending} offline confirmation${parts.offlinePending === 1 ? '' : 's'} verified and waiting to be redeemed.`);
  }
  if (parts.drafts) lines.push(`${parts.drafts} draft${parts.drafts === 1 ? '' : 's'} on your desk.`);
  if (parts.reminders.length) {
    lines.push('', 'Due today:');
    for (const reminder of parts.reminders) {
      lines.push(`• ${new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(reminder.dueAt))} ${reminder.body}`);
    }
  }
  if (parts.streak >= 2) lines.push('', `${parts.streak} day${parts.streak === 1 ? '' : 's'} in a row with a sale.`);
  return lines.join('\n');
}
