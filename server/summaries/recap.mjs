/**
 * The weekly recap — AI-free, like Butler's, retargeted at the shop:
 * what sold in the last 7 days, grouped, plus the day and the orders worth
 * another look. Counted, never guessed.
 */
import { getDb } from '../db.mjs';
import { localIso, money, safeZone } from './periods.mjs';

/** Where the 7-day window starts: local midnight 6 days ago, same as the brief. */
function startOfWeek(now, timeZone) {
  const iso = localIso(now, timeZone);
  const midnight = new Date(`${iso.slice(0, 10)}T00:00:00${iso.slice(19)}`);
  return new Date(midnight.getTime() - 6 * 86_400_000);
}

export function gather(now, timeZone, userId) {
  const from = startOfWeek(now, timeZone).getTime();
  const to = now.getTime();
  const db = getDb();

  const paid = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE user_id = ? AND status IN ('captured', 'settled') AND updated_at >= ? AND updated_at <= ?")
    .get(userId, from, to);
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM orders WHERE user_id = ? AND created_at >= ? AND created_at <= ? GROUP BY status ORDER BY n DESC')
    .all(userId, from, to);
  const highlights = db
    .prepare("SELECT id, total, customer, items, updated_at FROM orders WHERE user_id = ? AND status IN ('captured', 'settled') AND updated_at >= ? AND updated_at <= ? ORDER BY total DESC LIMIT 3")
    .all(userId, from, to);
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const best = db
    .prepare("SELECT updated_at, total FROM orders WHERE user_id = ? AND status IN ('captured', 'settled') AND updated_at >= ? AND updated_at <= ?")
    .all(userId, from, to);

  const byDay = new Map();
  for (const row of best) {
    const day = dayFormat.format(new Date(row.updated_at));
    byDay.set(day, (byDay.get(day) || 0) + row.total);
  }
  const bestDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  return {
    from: new Date(from).toISOString(),
    total: Math.round(paid.amount * 100) / 100,
    count: paid.n,
    byStatus: statusRows.map((row) => ({ status: row.status, count: row.n })),
    bestDay: bestDay ? { day: bestDay[0], total: Math.round(bestDay[1] * 100) / 100 } : null,
    highlights: highlights.map((row) => ({
      id: row.id.slice(0, 8),
      total: row.total,
      customer: row.customer || null,
      items: (JSON.parse(row.items || '[]')).map((item) => `${item.quantity} x ${item.name}`).join(', '),
      paidAt: row.updated_at,
    })),
    timeZone: safeZone(timeZone),
  };
}

/** The recap as a short plain note. */
export function compose(week) {
  if (!week.total) {
    return 'Your week in SoloCart: nothing captured in the last 7 days. Drafts and previews still count as work — the first capture will show up right here.';
  }
  const lines = [`Your week in SoloCart: ${money(week.total)} captured across ${week.count} order${week.count === 1 ? '' : 's'}.`];
  const statuses = week.byStatus.map((entry) => `${entry.status.replace(/_/g, ' ')} ${entry.count}`).join(', ');
  if (statuses) lines.push('', `Orders by state: ${statuses}.`);
  if (week.bestDay) lines.push(`Best day: ${week.bestDay.day} (${money(week.bestDay.total)}).`);
  if (week.highlights.length) {
    lines.push('', 'Worth another look:');
    for (const highlight of week.highlights) {
      const who = highlight.customer || highlight.items || 'an order';
      lines.push(`• ${money(highlight.total)} — ${who} (${highlight.id})`);
    }
  }
  return lines.join('\n');
}
