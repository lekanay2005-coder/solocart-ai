/**
 * Period arithmetic shared by the summaries (phase 2 totals, phase 4 brief,
 * recap and streaks). Weeks start on Monday, months and years on the 1st, all
 * computed in the seller's time zone rather than the server's.
 */

/** A time zone the server knows, or UTC. */
export function safeZone(tz) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The local time as ISO 8601 with its offset, e.g. 2026-10-29T11:40:00+01:00. */
export function localIso(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(now).map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** Today's date in `timeZone`, like 2026-10-29. */
export const today = (now, timeZone) => localIso(now, timeZone).slice(0, 10);

/** The last moment of today in `timeZone`. */
export function endOfDay(now, timeZone) {
  const iso = localIso(now, timeZone);
  return new Date(`${iso.slice(0, 10)}T23:59:59${iso.slice(19)}`);
}

/** When `period` began in `timeZone`. */
export function startOf(period, now, timeZone) {
  const iso = localIso(now, timeZone); // 2026-10-29T16:05:00+01:00
  const offset = iso.slice(19);
  const day = new Date(`${iso.slice(0, 10)}T00:00:00${offset}`);
  if (period === 'today') return day;
  if (period === 'month') return new Date(`${iso.slice(0, 8)}01T00:00:00${offset}`);
  if (period === 'year') return new Date(`${iso.slice(0, 5)}01-01T00:00:00${offset}`);
  const weekday = (new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - weekday * 86_400_000);
}

export const PERIODS = ['today', 'week', 'month', 'year'];

export const PERIOD_WORDS = { today: 'today', week: 'this week', month: 'this month', year: 'this year' };

/** Validates a client-supplied period, defaulting to `week`. */
export function readPeriod(value) {
  return PERIODS.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'week';
}

export function money(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${Number(amount).toLocaleString('en')} ${currency}`;
  }
}
