/**
 * PayPal Orders v2 — Sandbox only. The host is a module constant on purpose:
 * there is no env var that can point this app at live PayPal.
 *
 * - Access tokens are cached until shortly before expiry.
 * - Capture is idempotent: the caller persists one `PayPal-Request-Id` per
 *   order and reuses it, and an "already captured" answer is resolved by
 *   reading the order's current state rather than failing.
 * - Webhook signatures are verified with PayPal's
 *   `/v1/notifications/verify-webhook-signature` before any order changes.
 *
 * Every network call takes an injectable `fetchImpl` so tests can mock
 * PayPal without touching the network or the hard-wired host.
 */

export const PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';

export const isPaypalConfigured = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

/** Webhooks need the id of the webhook registered on the Sandbox app. */
export const webhookConfigured = () =>
  isPaypalConfigured() && Boolean(process.env.PAYPAL_WEBHOOK_ID);

/** @param {{ fetchImpl?: typeof fetch }} [deps] */
export function getAccessToken({ fetchImpl = fetch } = {}) {
  return cachedToken(fetchImpl);
}

let tokenCache = { value: null, expiresAt: 0 };

/** Test hook: forget the cached token. */
export function clearTokenCache() {
  tokenCache = { value: null, expiresAt: 0 };
}

async function cachedToken(fetchImpl) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetchImpl(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw paypalApiError('Sandbox authentication', response, payload);
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  return tokenCache.value;
}

/**
 * Creates a Sandbox order for a validated order draft.
 * @returns {Promise<{ orderId: string, approvalUrl: string, status: string }>}
 */
export async function createPaypalOrder(order, { fetchImpl = fetch } = {}) {
  const accessToken = await getAccessToken({ fetchImpl });
  const itemTotal = order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      description: 'SoloCart order',
      amount: {
        currency_code: 'USD',
        value: order.total.toFixed(2),
        breakdown: {
          item_total: { currency_code: 'USD', value: itemTotal.toFixed(2) },
          ...(order.shipping > 0
            ? { shipping: { currency_code: 'USD', value: order.shipping.toFixed(2) } }
            : {}),
        },
      },
      items: order.items.map((item) => ({
        name: item.name,
        quantity: String(item.quantity),
        unit_amount: { currency_code: 'USD', value: item.unitPrice.toFixed(2) },
      })),
    }],
    application_context: {
      brand_name: 'SoloCart Sandbox',
      user_action: 'PAY_NOW',
      return_url: `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4173}`}/paypal/return`,
      cancel_url: `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4173}`}/paypal/cancel`,
    },
  };
  const response = await fetchImpl(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // A stable id per create attempt, so a network retry can't duplicate.
      'PayPal-Request-Id': order.createRequestId,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw paypalApiError('Sandbox order creation', response, payload);
  if (!payload.id) throw new Error('PayPal Sandbox did not return an order ID.');
  const approvalUrl = payload.links?.find((link) => link.rel === 'approve')?.href
    || payload.links?.find((link) => link.rel === 'payer-action')?.href;
  if (!approvalUrl) throw new Error('PayPal did not return an approval link.');
  return { orderId: payload.id, approvalUrl, status: payload.status };
}

/**
 * Captures with a caller-supplied, persisted request id. Re-running with the
 * same id is a no-op; an "already captured" answer is resolved by reading the
 * order back, so capture is safe to retry forever.
 * @returns {Promise<{ status: string, payload: any }>}
 */
export async function capturePaypalOrder(paypalOrderId, captureRequestId, { fetchImpl = fetch } = {}) {
  const accessToken = await getAccessToken({ fetchImpl });
  const response = await fetchImpl(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': captureRequestId,
      },
      body: '{}',
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return { status: payload.status, payload };
  const issue = String(payload.details?.[0]?.issue || '');
  if (issue === 'ORDER_ALREADY_CAPTURED') {
    const current = await getOrderStatus(paypalOrderId, { fetchImpl });
    if (current) return { status: current, payload };
  }
  throw paypalApiError('Sandbox order capture', response, payload);
}

/** Reads an order's current status, used to resolve duplicate captures. */
export async function getOrderStatus(paypalOrderId, { fetchImpl = fetch } = {}) {
  const accessToken = await getAccessToken({ fetchImpl });
  const response = await fetchImpl(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const payload = await response.json().catch(() => ({}));
  return response.ok ? payload.status : null;
}

/**
 * An existing Sandbox order's approval link and status — what Ask Byte shows
 * when a seller asks to resend a checkout link. Returns nulls rather than
 * throwing when PayPal no longer has the order.
 */
export async function getOrderLinks(paypalOrderId, { fetchImpl = fetch } = {}) {
  const accessToken = await getAccessToken({ fetchImpl });
  const response = await fetchImpl(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { status: null, approvalUrl: null };
  const approvalUrl = payload.links?.find((link) => link.rel === 'approve')?.href
    || payload.links?.find((link) => link.rel === 'payer-action')?.href
    || null;
  return { status: payload.status || null, approvalUrl };
}

// --- webhooks -------------------------------------------------------------------

export const WEBHOOK_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
];

/**
 * Asks PayPal whether this webhook's signature is genuine. Returns true only
 * on an explicit SUCCESS; any problem (missing header, no webhook id
 * configured, API failure) is false — we never process an unverified event.
 *
 * @param {{ headers: Record<string, any>, event: any }} input
 * @param {{ fetchImpl?: typeof fetch, webhookId?: string }} [deps]
 */
export async function verifyWebhookSignature({ headers, event }, { fetchImpl = fetch, webhookId } = {}) {
  const id = webhookId || process.env.PAYPAL_WEBHOOK_ID;
  if (!id || !isPaypalConfigured()) return false;
  const normalized = {};
  for (const name of WEBHOOK_HEADERS) {
    const value = headers[name] ?? headers[name.toUpperCase()];
    if (!value) return false;
    normalized[name] = String(value);
  }
  if (!event || typeof event !== 'object') return false;

  let accessToken;
  try {
    accessToken = await getAccessToken({ fetchImpl });
  } catch {
    return false;
  }
  const response = await fetchImpl(`${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: normalized['paypal-auth-algo'],
      cert_url: normalized['paypal-cert-url'],
      transmission_id: normalized['paypal-transmission-id'],
      transmission_time: normalized['paypal-transmission-time'],
      transmission_sig: normalized['paypal-transmission-sig'],
      webhook_id: id,
      event,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok && payload.verification_status === 'SUCCESS';
}

/**
 * Maps a verified webhook event onto an order transition.
 * @returns {{ paypalOrderId: string|null, status: 'captured'|'failed'|null }}
 */
export function orderTransitionFromEvent(eventType, resource) {
  const paypalOrderId = resource?.order_id || (resource?.id && resource?.intent ? resource.id : null);
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') return { paypalOrderId, status: 'captured' };
  if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.REFUNDED') {
    return { paypalOrderId, status: 'failed' };
  }
  if (eventType === 'PAYMENT.CAPTURE.PENDING') return { paypalOrderId, status: null };
  return { paypalOrderId: null, status: null };
}

export function paypalApiError(operation, response, payload) {
  const issue = String(payload.details?.[0]?.issue || payload.error || '')
    .replace(/[^A-Z0-9_-]/gi, '')
    .slice(0, 48);
  const debugId = String(payload.debug_id || '')
    .replace(/[^A-Z0-9_-]/gi, '')
    .slice(0, 64);
  console.error(`[PayPal] ${operation} failed: HTTP ${response.status}; issue=${issue || 'unknown'}; debug_id=${debugId || 'unavailable'}`);
  const details = [issue && `issue ${issue}`, debugId && `debug ID ${debugId}`].filter(Boolean).join('; ');
  const error = new Error(`${operation} failed${details ? ` (${details})` : ''}.`);
  error.status = 502;
  error.expose = true;
  error.code = 'paypal_error';
  return error;
}
