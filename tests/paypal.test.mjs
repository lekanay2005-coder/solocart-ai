process.env.SOLOCART_DB = ':memory:';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYPAL_BASE_URL,
  capturePaypalOrder,
  clearTokenCache,
  orderTransitionFromEvent,
  verifyWebhookSignature,
} from '../server/paypal.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/cert',
  'paypal-transmission-id': 'transmission-1',
  'paypal-transmission-sig': 'signature-1',
  'paypal-transmission-time': '2026-10-29T00:00:00Z',
};

const EVENT = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { order_id: 'ORDER-1' } };

test.beforeEach(() => clearTokenCache());

test('a genuine webhook signature verifies', async () => {
  const seen = [];
  const result = await verifyWebhookSignature(
    { headers: HEADERS, event: EVENT },
    {
      webhookId: 'test-webhook-id',
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'token-1', expires_in: 3600 });
        return json({ verification_status: 'SUCCESS' });
      },
    },
  );
  assert.equal(result, true);
  const call = seen.find((entry) => entry.url.includes('verify-webhook-signature'));
  assert.ok(call, 'PayPal verify endpoint must be called');
  assert.ok(call.url.startsWith(PAYPAL_BASE_URL), 'verification stays on the Sandbox host');
  const body = JSON.parse(call.init.body);
  assert.equal(body.webhook_id, 'test-webhook-id');
  assert.equal(body.transmission_sig, 'signature-1');
  assert.equal(body.event.event_type, 'PAYMENT.CAPTURE.COMPLETED');
});

test('a signature PayPal rejects is not believed', async () => {
  const result = await verifyWebhookSignature(
    { headers: { ...HEADERS, 'paypal-transmission-sig': 'forged' }, event: EVENT },
    {
      webhookId: 'test-webhook-id',
      fetchImpl: async (url) => (url.endsWith('/v1/oauth2/token')
        ? json({ access_token: 'token-1', expires_in: 3600 })
        : json({ verification_status: 'FAILURE' })),
    },
  );
  assert.equal(result, false);
});

test('missing transmission headers fail closed', async () => {
  const fetchImpl = async () => json({ verification_status: 'SUCCESS' });
  for (const header of Object.keys(HEADERS)) {
    const headers = { ...HEADERS };
    delete headers[header];
    assert.equal(await verifyWebhookSignature({ headers, event: EVENT }, { webhookId: 'test-webhook-id', fetchImpl }), false, header);
  }
});

test('without a webhook id or credentials, verification always fails', async () => {
  delete process.env.PAYPAL_WEBHOOK_ID;
  try {
    assert.equal(await verifyWebhookSignature({ headers: HEADERS, event: EVENT }, {
      fetchImpl: async () => json({ verification_status: 'SUCCESS' }),
    }), false);
  } finally {
    process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  }
});

test('capture reuses one PayPal-Request-Id and reports the final status', async () => {
  const calls = [];
  const result = await capturePaypalOrder('ORDER-1', 'capture-req-1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'token-1', expires_in: 3600 });
      return json({ status: 'COMPLETED', id: 'ORDER-1' });
    },
  });
  assert.equal(result.status, 'COMPLETED');
  const capture = calls.find((call) => call.url.endsWith('/capture'));
  assert.equal(capture.init.headers['PayPal-Request-Id'], 'capture-req-1');
});

test('an already-captured order resolves by reading its status, not by failing', async () => {
  const result = await capturePaypalOrder('ORDER-1', 'capture-req-1', {
    fetchImpl: async (url) => {
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'token-1', expires_in: 3600 });
      if (url.endsWith('/capture')) {
        return json({ details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 422);
      }
      return json({ status: 'COMPLETED', id: 'ORDER-1' });
    },
  });
  assert.equal(result.status, 'COMPLETED');
});

test('webhook events map onto order transitions', () => {
  assert.deepEqual(orderTransitionFromEvent('PAYMENT.CAPTURE.COMPLETED', { order_id: 'O-1' }), { paypalOrderId: 'O-1', status: 'captured' });
  assert.deepEqual(orderTransitionFromEvent('PAYMENT.CAPTURE.DENIED', { order_id: 'O-1' }), { paypalOrderId: 'O-1', status: 'failed' });
  assert.deepEqual(orderTransitionFromEvent('PAYMENT.CAPTURE.PENDING', { order_id: 'O-1' }).status, null);
  assert.equal(orderTransitionFromEvent('CHECKOUT.ORDER.APPROVED', { id: 'O-1' }).status, null);
  assert.equal(orderTransitionFromEvent('CUSTOM.EVENT', {}).status, null);
});
