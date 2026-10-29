/**
 * Server-side ledger for offline payments — issue, confirm, redeem.
 *
 * This is the piece Morrow never built ("Redemption is not wired yet"):
 * the place where an OfflineAuthorization that was created with zero
 * connectivity is finally checked against every authorization seen before.
 *
 * Three states on a request:
 *   pending   — the seller issued a signed PaymentRequest for a draft order
 *   confirmed — the buyer's signed PaymentConfirmation was verified here
 *   redeemed  — the seller redeemed it; recorded once, then the order settles
 *
 * Replay guards (why a tampered or replayed authorization is rejected):
 *   * the confirmation must verify against the exact server-issued request
 *     (checksum body, id, amount, currency, Ed25519 signature);
 *   * `offline_requests.status` only advances forward, and the UPDATEs below
 *     are guarded on the current status, so a second confirm or redeem of the
 *     same payload is a 409, not a double record;
 *   * `offline_redeemptions` UNIQUE(allowance_id, sequence) makes it
 *     impossible to redeem the same signed spend twice — even if it arrives
 *     wrapped in a fresh confirmation for a different request.
 *
 * Settlement is honestly labeled: the handoff is offline, settlement is not.
 * Without PayPal credentials (or any real custodian), redeeming marks the
 * order `settled` in the *ledger sense* and every surface says simulated —
 * see docs/OFFLINE_PAYMENTS.md.
 */
import { getDb } from '../db.mjs';
import { HttpError } from '../http.mjs';
import * as orderslib from '../orders.mjs';
import * as protocol from './protocol.mjs';

/**
 * How long a buyer has to hand over a confirmation. Read at call time:
 * `.env` is loaded after module imports, so a module-level constant would
 * never see it. Override with OFFLINE_REQUEST_TTL_MINUTES.
 */
export function requestTtlMinutes() {
  return Math.max(1, Number(process.env.OFFLINE_REQUEST_TTL_MINUTES) || 60);
}

export const CONFIRM_NOTICE = 'Signed confirmation verified — settlement pending. Only the handoff was offline; the seller redeems it next.';
export const SETTLEMENT_NOTICE = 'Authorization verified and recorded, order settled. Simulated settlement: this prototype moves no money offline — a real deployment needs an online redemption service (docs/OFFLINE_PAYMENTS.md).';

const REQUEST_ID_RE = /^req_[0-9a-f]{20}$/;

const COLUMNS = 'id, user_id, order_id, payload, request_json, amount_minor, currency, status, confirmation_json, created_at, expires_at, confirmed_at, redeemed_at';

/** `pending` rows past their expiry read as `expired` without a write. */
function effectiveStatus(row, now) {
  if (row.status === 'pending' && row.expires_at <= now) return 'expired';
  return row.status;
}

function hydrate(row, now = Date.now()) {
  let request = null;
  try {
    request = JSON.parse(row.request_json);
  } catch {
    request = null;
  }
  return {
    requestId: row.id,
    orderId: row.order_id,
    status: effectiveStatus(row, now),
    payload: row.payload,
    request,
    amountMinor: row.amount_minor,
    amount: row.amount_minor / 100,
    currency: row.currency,
    note: request?.note || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    redeemedAt: row.redeemed_at,
  };
}

// --- issue -----------------------------------------------------------------------

/**
 * Issues a signed-payment-request payload for a *draft* order. Draft-only by
 * design: an order already moving through PayPal checkout must not also take
 * an offline payment (double-charge), and a settled order needs nothing.
 */
export function issueRequest(user, order) {
  if (!order) throw new HttpError(404, 'That order is not on this desk.', 'not_found');
  if (order.status !== 'draft') {
    throw new HttpError(409, 'Offline requests are issued from a draft order — PayPal-checkout orders settle through PayPal instead.', 'bad_order_status');
  }
  if (!(order.total > 0)) {
    throw new HttpError(400, 'The order total must be above zero before issuing a payment request.', 'invalid_order');
  }
  const currency = order.currency === 'NGN' ? 'NGN' : 'USD';
  const amountMinor = Math.round(Number(order.total) * 100);
  const itemsNote = (order.items || []).map((item) => `${item.quantity} × ${item.name}`).join(', ');
  const note = String(order.note || itemsNote || 'Order payment').slice(0, 120);

  const now = Date.now();
  const request = protocol.createPaymentRequest({
    amountMinor,
    currency,
    note,
    merchant: {
      id: `mer_${String(user.id).replace(/[^0-9a-f]/g, '').slice(0, 12)}`,
      name: String(user.name || 'SoloCart seller').slice(0, 60),
      account: 'SoloCart',
      bmoniUserId: String(user.id), // Morrow wire field; carries the seller's local id (no BMONI in SoloCart)
    },
    expiresAt: now + requestTtlMinutes() * 60_000,
    now,
  });

  const db = getDb();
  db.prepare(
    `INSERT INTO offline_requests (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL)`,
  ).run(
    request.id,
    user.id,
    order.id,
    protocol.serializeRequest(request),
    JSON.stringify(request),
    amountMinor,
    currency,
    now,
    request.expiresAt,
  );
  return hydrate(db.prepare(`SELECT ${COLUMNS} FROM offline_requests WHERE id = ?`).get(request.id), now);
}

export function listRequests(userId) {
  const now = Date.now();
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM offline_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(userId);
  return rows.map((row) => hydrate(row, now));
}

function ownedRow(userId, requestId) {
  if (!REQUEST_ID_RE.test(requestId)) throw new HttpError(404, 'That offline request does not exist.', 'not_found');
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM offline_requests WHERE id = ? AND user_id = ?`).get(requestId, userId);
  if (!row) throw new HttpError(404, 'That offline request does not exist.', 'not_found');
  return row;
}

/** Public share read for the buyer page: the request body, nothing else. */
export function findShare(requestId) {
  if (!REQUEST_ID_RE.test(requestId)) return null;
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM offline_requests WHERE id = ?`).get(requestId);
  if (!row) return null;
  const view = hydrate(row);
  return { requestId: row.id, request: view.request, status: view.status, expiresAt: view.expiresAt };
}

// --- confirm ---------------------------------------------------------------------

const redeemedByAllowance = (allowanceId, sequence) =>
  Boolean(getDb().prepare('SELECT 1 FROM offline_redeemptions WHERE allowance_id = ? AND sequence = ?').get(String(allowanceId), Number(sequence)));
const redeemedRequest = (requestId) =>
  Boolean(getDb().prepare('SELECT 1 FROM offline_redeemptions WHERE request_id = ?').get(String(requestId)));

/**
 * The buyer's signed handoff. Verifies the confirmation against the stored
 * request (Morrow's checks, replay hooks backed by SQLite) and parks it on
 * the request as `confirmed`. Does NOT settle — redemption is a separate,
 * seller-side act, exactly so nothing can be marked settled before the
 * server has done its verification.
 */
export async function confirm({ requestId, confirmationInput }) {
  const db = getDb();
  const row = db.prepare(`SELECT ${COLUMNS} FROM offline_requests WHERE id = ?`).get(String(requestId || ''));
  if (!row) throw new HttpError(404, 'That offline request does not exist.', 'not_found');

  const now = Date.now();
  const status = effectiveStatus(row, now);
  if (status === 'redeemed') throw new HttpError(409, 'This request has already been redeemed.', 'already_redeemed');
  if (status === 'confirmed') throw new HttpError(409, 'A confirmation was already handed over for this request.', 'already_confirmed');
  if (status === 'expired') throw new HttpError(410, 'This payment request has expired — ask the seller to issue a new one.', 'request_expired');

  let confirmation = confirmationInput;
  if (typeof confirmation === 'string') {
    try {
      confirmation = protocol.deserializeConfirmation(confirmation);
    } catch {
      throw new HttpError(400, 'The confirmation payload could not be read.', 'bad_payload');
    }
  }
  if (!confirmation || typeof confirmation !== 'object') {
    throw new HttpError(400, 'Send the signed confirmation payload.', 'bad_payload');
  }
  if (typeof confirmation.offlineAuthorization !== 'object' || !confirmation.offlineAuthorization) {
    throw new HttpError(400, 'An offline payment needs the signed offline authorization inside the confirmation.', 'missing_authorization');
  }

  const request = JSON.parse(row.request_json);
  const verdict = await protocol.verifyPaymentConfirmation(confirmation, request, {
    wasProcessed: async () => redeemedRequest(row.id),
    wasRedeemed: async (allowanceId, sequence) => redeemedByAllowance(allowanceId, sequence),
  });
  if (!verdict.valid) throw new HttpError(400, verdict.reason, 'verification_failed');

  const written = db
    .prepare(
      `UPDATE offline_requests SET status = 'confirmed', confirmation_json = ?, confirmed_at = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .run(JSON.stringify(confirmation), now, row.id, now);
  if (written.changes === 0) {
    throw new HttpError(409, 'This request changed while verifying — reload and try again.', 'stale_status');
  }

  // Park the linked order one step forward, atomically with the confirm, so
  // nothing else can move it in between. `settled` still requires redemption.
  if (row.order_id) {
    const order = orderslib.getOrder(row.user_id, row.order_id);
    if (order && order.status === 'draft') {
      try {
        orderslib.transition(order, 'paid_offline_pending');
        orderslib.addEvent(row.user_id, {
          kind: 'offline',
          title: 'Offline payment verified',
          detail: 'Signed confirmation accepted · awaiting seller redemption',
          amount: row.amount_minor / 100,
          at: now,
        });
      } catch (error) {
        if (!(error instanceof HttpError) || (error.code !== 'stale_status' && error.code !== 'illegal_transition')) throw error;
      }
    }
  }
  return { requestId: row.id, orderId: row.order_id, userId: row.user_id, confirmation, request };
}

// --- redeem ----------------------------------------------------------------------

/**
 * The seller's settle action: re-verifies the parked confirmation from
 * scratch, records the redemption once (double-spend guard), then settles the
 * linked order. Verification runs again here even though confirm already
 * passed — redemption must be independently computable from what is stored.
 *
 * @returns {{ requestId: string, orderId: string|null, amountMinor: number, currency: string, channel: string, notice: string }}
 */
export async function redeem(user, requestId) {
  const db = getDb();
  const row = ownedRow(user.id, String(requestId || ''));
  const now = Date.now();

  if (row.status === 'redeemed') throw new HttpError(409, 'This payment has already been redeemed.', 'already_redeemed');
  if (row.status !== 'confirmed' || !row.confirmation_json) {
    throw new HttpError(409, 'No verified confirmation is waiting on this request.', 'not_confirmed');
  }

  const request = JSON.parse(row.request_json);
  const confirmation = JSON.parse(row.confirmation_json);
  const auth = confirmation.offlineAuthorization;

  // The whole post-verification sequence below is synchronous, so in this
  // single-process server nothing can interleave between the checks and the
  // inserts — the guards cannot race each other.
  const verdictPromise = protocol.verifyPaymentConfirmation(confirmation, request, {
    wasProcessed: async () => redeemedRequest(row.id),
    wasRedeemed: async (allowanceId, sequence) => redeemedByAllowance(allowanceId, sequence),
  });
  return verdictPromise.then((verdict) => {
    if (!verdict.valid) throw new HttpError(409, verdict.reason, 'verification_failed');
    if (redeemedByAllowance(auth.allowanceId, auth.sequence)) {
      throw new HttpError(409, 'This authorization has already been redeemed (double-spend guard).', 'double_spend');
    }

    db.prepare(
      `INSERT INTO offline_redeemptions
         (id, request_id, user_id, order_id, allowance_id, sequence, payer_public_key,
          amount_minor, currency, confirmation_json, authorization_json, channel, redeemed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline-reserve', ?)`,
    ).run(
      `rdm_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      row.id,
      user.id,
      row.order_id,
      String(auth.allowanceId),
      Number(auth.sequence),
      String(confirmation.signerPublicKey || ''),
      row.amount_minor,
      row.currency,
      JSON.stringify(confirmation),
      JSON.stringify(auth),
      now,
    );

    const written = db
      .prepare("UPDATE offline_requests SET status = 'redeemed', redeemed_at = ? WHERE id = ? AND status = 'confirmed'")
      .run(now, row.id);
    if (written.changes === 0) throw new HttpError(409, 'This payment was redeemed concurrently.', 'stale_status');

    settleOrder(user, row, now);
    return {
      requestId: row.id,
      orderId: row.order_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      channel: 'offline-reserve (simulated settlement)',
      notice: SETTLEMENT_NOTICE,
    };
  });
}

/** draft -> paid_offline_pending -> settled, tolerating a lost race. */
function settleOrder(user, row, now) {
  if (!row.order_id) return;
  let order = orderslib.getOrder(user.id, row.order_id);
  if (!order) return;
  try {
    if (order.status === 'draft') {
      order = orderslib.transition(order, 'paid_offline_pending');
    }
    if (order.status === 'paid_offline_pending') {
      order = orderslib.transition(order, 'settled');
    }
  } catch (error) {
    // A webhook or a second tab moving the order first is not a redemption
    // failure — the redemption itself is already recorded above.
    if (!(error instanceof HttpError) || (error.code !== 'stale_status' && error.code !== 'illegal_transition')) throw error;
  }
  orderslib.addEvent(user.id, {
    kind: 'offline',
    title: 'Offline payment redeemed',
    detail: `Signed authorization verified · simulated settlement · ${row.id.slice(0, 12)}`,
    amount: row.amount_minor / 100,
    at: now,
  });
}
