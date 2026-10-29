/**
 * Orders, the order state machine, and the activity feed — all server-side,
 * all scoped to one user.
 *
 * State machine (phase 1):
 *   draft -> awaiting_buyer -> captured | failed | expired
 * Phase 3 adds the offline branch: draft -> paid_offline_pending -> settled.
 * Transitions are enforced here; nothing else writes `status`.
 *
 * Totals are always computed in code (`computeTotals`), never taken from a
 * model or a client's arithmetic.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from './db.mjs';
import { HttpError } from './http.mjs';

/** Statuses an order may hold. */
export const ORDER_STATUSES = [
  'draft',
  'awaiting_buyer',
  'captured',
  'failed',
  'expired',
  'paid_offline_pending',
  'settled',
];

/** Allowed transitions. Anything not listed here is refused. */
export const TRANSITIONS = {
  draft: ['awaiting_buyer', 'paid_offline_pending'],
  awaiting_buyer: ['captured', 'failed', 'expired'],
  paid_offline_pending: ['settled', 'failed'],
  captured: [],
  settled: [],
  failed: [],
  expired: [],
};

export const TERMINAL_STATUSES = Object.keys(TRANSITIONS).filter((status) => TRANSITIONS[status].length === 0);

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/** Throws a 409 when `from -> to` is not a legal move. */
export function assertTransition(from, to) {
  if (!ORDER_STATUSES.includes(to)) {
    throw new HttpError(400, `Unknown order status "${to}".`, 'bad_status');
  }
  if (!canTransition(from, to)) {
    throw new HttpError(409, `An order cannot go from ${from} to ${to}.`, 'illegal_transition');
  }
}

// --- money ----------------------------------------------------------------------

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Line totals plus shipping, rounded to cents. Pure; the only source of totals. */
export function computeTotals(items, shipping) {
  const itemTotal = roundMoney(
    (Array.isArray(items) ? items : []).reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0),
  );
  const ship = roundMoney(shipping || 0);
  return { itemTotal, shipping: ship, total: roundMoney(itemTotal + ship) };
}

export function summarizeOrder({ items, shipping, note }) {
  const { itemTotal, shipping: ship, total } = computeTotals(items, shipping);
  return { currency: 'USD', items, shipping: ship, itemTotal, total, note };
}

/** Product names are text we send to PayPal; keep them printable and short. */
export function safeName(value) {
  const clean = String(value || '').replace(/[^\p{L}\p{N} &'-]/gu, '').trim();
  return clean.slice(0, 60) || 'Custom item';
}

/**
 * Validates an order draft coming from the client. Throws a 400 with a
 * human-readable message when anything is off.
 */
export function validateOrder(body) {
  const items = Array.isArray(body?.items)
    ? body.items.slice(0, 10).map((item) => ({
      name: safeName(item?.name),
      quantity: Math.trunc(Number(item?.quantity)),
      unitPrice: roundMoney(item?.unitPrice),
    }))
    : [];
  if (
    !items.length
    || items.some((item) => !Number.isInteger(item.quantity)
      || item.quantity < 1
      || item.quantity > 99
      || !Number.isFinite(item.unitPrice)
      || item.unitPrice <= 0
      || item.unitPrice > 10000)
  ) {
    throw new HttpError(400, 'Add valid item names, quantities, and positive prices before checkout.', 'invalid_order');
  }
  const shipping = roundMoney(body?.shipping);
  if (!Number.isFinite(shipping) || shipping < 0 || shipping > 10000) {
    throw new HttpError(400, 'Shipping must be between $0 and $10,000.', 'invalid_shipping');
  }
  const order = summarizeOrder({ items, shipping, note: String(body?.note || '').slice(0, 180) });
  if (order.total <= 0 || order.total > 10000) {
    throw new HttpError(400, 'The order total must be between $0.01 and $10,000.', 'invalid_total');
  }
  return order;
}

// --- storage --------------------------------------------------------------------

const MAX_DRAFTS_PER_USER = 50;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const COLUMNS = 'id, user_id, status, currency, items, shipping, item_total, total, note, source, paypal_order_id, capture_request_id, created_at, updated_at, expires_at, customer';

function hydrate(row) {
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items);
  } catch {
    items = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    currency: row.currency,
    items,
    shipping: row.shipping,
    itemTotal: row.item_total,
    total: row.total,
    note: row.note,
    customer: row.customer,
    source: row.source,
    paypalOrderId: row.paypal_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** Persists a parsed draft, keeping the per-user draft list bounded. */
export function createDraft(userId, order, source = 'local', customer = null) {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO orders (${COLUMNS}) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
  ).run(
    id,
    userId,
    order.currency || 'USD',
    JSON.stringify(order.items || []),
    order.shipping || 0,
    order.itemTotal || 0,
    order.total || 0,
    String(order.note || ''),
    source,
    now,
    now,
    customer ? String(customer).slice(0, 60) : null,
  );
  db.prepare(
    "DELETE FROM orders WHERE user_id = ? AND status = 'draft' AND id <> ? AND created_at < ?",
  ).run(userId, id, now - DRAFT_TTL_MS);
  const stale = db
    .prepare(
      `SELECT id FROM orders WHERE user_id = ? AND status = 'draft' AND id <> ?
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(userId, id, MAX_DRAFTS_PER_USER);
  for (const row of stale) db.prepare('DELETE FROM orders WHERE id = ?').run(row.id);
  return getOrder(userId, id);
}

export function listOrders(userId, { status = null, limit = 100 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare(`SELECT ${COLUMNS} FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`).all(userId, status, limit)
    : db.prepare(`SELECT ${COLUMNS} FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
  return rows.map(hydrate);
}

export function getOrder(userId, orderId) {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM orders WHERE id = ? AND user_id = ?`).get(String(orderId || ''), userId);
  return hydrate(row);
}

export function findOrderByPaypalId(paypalOrderId) {
  if (!paypalOrderId) return null;
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM orders WHERE paypal_order_id = ?`).get(String(paypalOrderId));
  return hydrate(row);
}

/**
 * Moves an order to `to`, applying `patch` atomically and only if the
 * transition is legal from its *current* status (checked in the same
 * statement, so a webhook and a return-redirect cannot race).
 *
 * @param {{ id: string, status: string }} current
 * @param {string} to
 * @param {{ paypalOrderId?: string|null, captureRequestId?: string|null, source?: string, expiresAt?: number|null }} [patch]
 */
export function transition(current, to, patch = {}) {
  assertTransition(current.status, to);
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE orders SET status = ?,
         paypal_order_id = COALESCE(?, paypal_order_id),
         capture_request_id = COALESCE(?, capture_request_id),
         source = COALESCE(?, source),
         expires_at = COALESCE(?, expires_at),
         updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(
      to,
      patch.paypalOrderId ?? null,
      patch.captureRequestId ?? null,
      patch.source ?? null,
      patch.expiresAt ?? null,
      now,
      current.id,
      current.status,
    );
  if (result.changes === 0) {
    throw new HttpError(409, 'This order already moved on; reload it and try again.', 'stale_status');
  }
  return getOrder(current.userId ?? current.user_id, current.id);
}

/** Marks overdue awaiting-buyer orders expired. Returns how many changed. */
export function expireStaleOrders(now = Date.now()) {
  const db = getDb();
  return db
    .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'awaiting_buyer' AND expires_at IS NOT NULL AND expires_at < ?")
    .run(now, now).changes;
}

// --- activity feed ---------------------------------------------------------------

/**
 * Records one server-side event. Events are never written by the browser, so
 * the feed can't be inflated by a script.
 * @param {{ kind?: string, title: string, detail?: string, amount?: number|null, at?: number }} input
 */
export function addEvent(userId, { kind = 'general', title, detail = '', amount = null, at = Date.now() }) {
  const id = randomUUID();
  getDb()
    .prepare('INSERT INTO events (id, user_id, kind, title, detail, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, kind, String(title).slice(0, 120), String(detail).slice(0, 300), amount == null ? null : roundMoney(amount), at);
  return id;
}

/** Events in the shape the existing UI renders: `{id, title, detail, amount, time}`. */
export function listEvents(userId, limit = 200) {
  return getDb()
    .prepare('SELECT id, title, detail, amount, created_at FROM events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, limit)
    .map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.detail,
      amount: row.amount,
      time: new Date(row.created_at).toISOString(),
    }));
}

/** Counted totals for the overview, computed here rather than in the browser. */
export function activitySummary(userId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM events WHERE user_id = ?')
    .get(userId);
  return { count: row.count, amount: roundMoney(row.amount) };
}
