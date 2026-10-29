process.env.SOLOCART_DB = ':memory:';
// Deliberately no keys: this file proves the zero-key path.
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';

import { extract, parseLocal, validateExtraction } from '../server/ai/orders.mjs';
import { validateOrder } from '../server/orders.mjs';
import { classify, isExplicitOrder, segmentChunks, looksLikeOrder, cleanUrl, extractUrl } from '../server/ai/rules.mjs';
import { providerOrder, providersReady, providerStatus, activeLabel, complete, fastestGemini } from '../server/ai/providers.mjs';

test('segmentChunks splits a run-on message at every price boundary', () => {
  assert.deepEqual(segmentChunks('2 baskets $18 delivery $5'), ['2 baskets $18', 'delivery $5']);
  assert.deepEqual(segmentChunks('2 handwoven baskets at $18 each, delivery $5'), ['2 handwoven baskets at $18 each', 'delivery $5']);
  assert.deepEqual(segmentChunks('$4 delivery, 2 scarves $25'), ['$4 delivery', '2 scarves $25']);
  assert.deepEqual(segmentChunks('\n  1 tote bag $30 \n'), ['1 tote bag $30']);
});

test('the local parser reads the brief’s example correctly', () => {
  const { order } = parseLocal('2 baskets $18 delivery $5');
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].unitPrice, 18);
  assert.equal(order.shipping, 5);
  assert.equal(order.total, 41);
});

test('the local parser still handles the original patterns', () => {
  const classic = parseLocal('2 handwoven baskets at $18 each, delivery $5').order;
  assert.equal(classic.total, 41);
  const multi = parseLocal('3 ceramic mugs at $14 each, delivery $4').order;
  assert.equal(multi.itemTotal, 42);
  const lead = parseLocal('$4 delivery, 2 scarves $25').order;
  assert.equal(lead.shipping, 4);
  assert.equal(lead.total, 54);
});

test('the local parser refuses input it genuinely cannot read', () => {
  assert.throws(() => parseLocal('just a chat message with no prices'), (error) => error.status === 422);
  assert.throws(() => parseLocal('widgets at $0 each'), (error) => error.status === 422);
});

test('rules recognise an explicit order and skip the model', () => {
  assert.equal(isExplicitOrder('2 baskets $18 delivery $5'), true);
  assert.equal(isExplicitOrder('3 mugs at $14 each'), true);
  assert.equal(isExplicitOrder('can you do 2 baskets for $18?'), false); // a question
  assert.equal(isExplicitOrder('hi there'), false);
  assert.equal(isExplicitOrder('I would like the blue one, how much is shipping?'), false);
  assert.equal(classify('2 baskets $18 delivery $5'), 'order');
  assert.equal(classify('what did Amira order?'), 'question');
  assert.equal(classify('thanks!'), 'greeting');
});

test('looksLikeOrder keeps trivia out of the model', () => {
  assert.equal(looksLikeOrder('the mug is $12'), true);
  assert.equal(looksLikeOrder('hey'), false);
  assert.equal(looksLikeOrder('x'.repeat(1300)), false);
});

test('link helpers from Butler’s rules survive the port', () => {
  assert.equal(extractUrl('see https://example.com/a?utm_source=x. thanks'), 'https://example.com/a?utm_source=x');
  assert.equal(cleanUrl('https://example.com/a?utm_source=x&id=7'), 'https://example.com/a?id=7');
  assert.equal(extractUrl('no link here'), null);
});

test('with zero keys, extraction falls through to rules then local — never throws', async () => {
  assert.equal(providersReady(), false);
  const explicit = await extract('2 baskets $18 delivery $5');
  assert.equal(explicit.source, 'rules');
  assert.equal(explicit.order.total, 41);

  const chatty = await extract('customer says: handmade vase for $25');
  assert.ok(['local', 'rules'].includes(chatty.source));
  assert.equal(chatty.order.total, 25);

  await assert.rejects(extract('nothing interesting here'), (error) => error.status === 422);
});

test('validateExtraction re-checks model output in code', () => {
  const good = validateExtraction({
    items: [{ name: 'Mug', quantity: 3, unitPrice: 14.5 }],
    shipping: 4,
    note: 'ok',
    customer: 'Amira',
  });
  assert.equal(good.order.itemTotal, 43.5);
  assert.equal(good.customer, 'Amira');

  // Sloppy values are clamped, not trusted.
  const sloppy = validateExtraction({ items: [{ name: '  <b>Mug</b>  ', quantity: '7', unitPrice: 99999 }], shipping: -5, note: 'x' });
  assert.equal(sloppy.order.items[0].quantity, 7);
  assert.equal(sloppy.order.items[0].unitPrice, 10000);
  assert.equal(sloppy.order.shipping, 0);
  assert.equal(sloisyCheck(sloppy), true);

  assert.throws(() => validateExtraction({ items: [], shipping: 0, note: '' }), (error) => error.status === 422);
  assert.throws(() => validateExtraction(null), (error) => error.status === 422);

  // A $0 price is a deliberate placeholder the model is told to emit when the
  // message names a product without a price: the draft keeps it, the seller
  // fills it in, and checkout (validateOrder) still refuses it.
  const placeholder = validateExtraction({ items: [{ name: 'Mug', quantity: 1, unitPrice: 0 }], shipping: 0, note: '' });
  assert.equal(placeholder.order.items[0].unitPrice, 0);
  assert.throws(() => validateOrder(placeholder.order), (error) => error.status === 400);
});

function sloisyCheck(result) {
  // Names must never keep markup through to PayPal.
  return !/[<>]/.test(result.order.items[0].name);
}

test('provider reporting never leaks key material', () => {
  process.env.OPENAI_API_KEY = 'sk-secret-value,sk-second-secret';
  process.env.GROQ_API_KEY = 'gsk_secret';
  try {
    const status = providerStatus();
    const asText = JSON.stringify(status);
    assert.equal(asText.includes('sk-secret'), false);
    assert.equal(asText.includes('gsk_secret'), false);
    assert.equal(status.find((entry) => entry.id === 'openai').keys, 2);
    assert.equal(status.find((entry) => entry.id === 'gemini').live, false);
    assert.deepEqual(providerOrder(), ['openai', 'groq']);
    assert.match(activeLabel(), /^OpenAI · /);
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  }
});

test('AI_PROVIDER_ORDER controls which provider is tried first', () => {
  process.env.OPENAI_API_KEY = 'a';
  process.env.GROQ_API_KEY = 'b';
  process.env.AI_PROVIDER_ORDER = 'groq, openai, gemini';
  try {
    assert.deepEqual(providerOrder(), ['groq', 'openai']);
  } finally {
    delete process.env.AI_PROVIDER_ORDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  }
});

test('a bad key falls through to the next provider, and the error names each one', async () => {
  process.env.OPENAI_API_KEY = 'bad-key';
  process.env.GROQ_API_KEY = 'also-bad';
  process.env.AI_PROVIDER_ORDER = 'openai,groq';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 });
  };
  try {
    await assert.rejects(complete({ prompt: 'hello', fetchImpl }), (error) => {
      assert.equal(error.code, 'no_provider');
      assert.match(error.message, /OpenAI/);
      assert.match(error.message, /Groq/);
      return true;
    });
    assert.equal(calls.length, 2, 'each configured provider is tried once');
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.AI_PROVIDER_ORDER;
  }
});

test('a working provider returns text through the chain', async () => {
  process.env.GROQ_API_KEY = 'good-key';
  process.env.AI_PROVIDER_ORDER = 'groq';
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"hello":"world"}' } }] }), { status: 200 });
  try {
    const result = await complete({ prompt: 'hi', json: {}, fetchImpl });
    assert.equal(result.provider, 'groq');
    assert.equal(result.model.length > 0, true);
  } finally {
    delete process.env.GROQ_API_KEY;
    delete process.env.AI_PROVIDER_ORDER;
  }
});

test('Gemini model ranking prefers stable, fast, current models', () => {
  const ranked = fastestGemini(['gemini-2.0-flash-preview', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-image-gen']);
  assert.equal(ranked.includes('gemini-image-gen'), false);
  assert.equal(ranked[0], 'gemini-flash-lite-latest');
  assert.equal(ranked[ranked.length - 1], 'gemini-2.0-flash-preview');
});
