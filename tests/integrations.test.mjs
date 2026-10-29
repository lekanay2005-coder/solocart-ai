process.env.SOLOCART_DB = ':memory:';
process.env.APP_VAULT_KEY = 'test-vault-key-for-phase-4';
delete process.env.APP_BASE_URL;

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { isPrivateAddress, checkUrl, guardedFetch } from '../server/integrations/outbound.mjs';
import { lock, unlock, vaultReady } from '../server/integrations/vault.mjs';
import * as mcp from '../server/integrations/mcp.mjs';
import { getDb } from '../server/db.mjs';

// --- outbound: the SSRF guard -----------------------------------------------------

test('private, loopback and link-local addresses are refused', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.5', '192.168.1.7', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '127.255.255.254', '224.0.0.1',
    '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`);

  const publicIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '104.16.0.1', '2606:4700::1111'];
  for (const ip of publicIps) assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
});

test('the SSRF guard refuses unsafe links before any request is made', async () => {
  await assert.rejects(checkUrl('http://example.com/hook'), /https/, 'only https');
  await assert.rejects(checkUrl('ftp://example.com/hook'), /https/);
  await assert.rejects(checkUrl('https://user:pass@example.com/hook'), /password/, 'no credentials in the URL');
  await assert.rejects(checkUrl('https://localhost:3000/hook'), /public addresses/);
  await assert.rejects(checkUrl('https://127.0.0.1/hook'), /public addresses/);
  await assert.rejects(checkUrl('https://169.254.169.254/latest/meta-data/'), /public addresses/, 'cloud metadata');
  await assert.rejects(checkUrl('https://10.0.0.8/hook'), /public addresses/);
  await assert.rejects(checkUrl('https://printer.lan/hook'), /public addresses/);
  await assert.rejects(checkUrl('not a url'), /isn't a web address/);

  // A genuinely public name passes (DNS is injected so no network is needed)...
  const url = await checkUrl('https://api.example.com/hook', async () => ['93.184.216.34']);
  assert.equal(url.hostname, 'api.example.com');
  // ...but a name that resolves into this machine does not.
  await assert.rejects(checkUrl('https://my-shop.example/hook', async () => ['127.0.0.1']), /public addresses/);
});

test('guardedFetch checks every redirect hop and never crosses origins', async () => {
  const realFetch = globalThis.fetch;
  try {
    // Same-origin redirect: followed, re-checked, then answered.
    let hop = 0;
    globalThis.fetch = async () => {
      hop += 1;
      return hop === 1
        ? new Response(null, { status: 307, headers: { location: 'https://api.example.com/next' } })
        : new Response('ok', { status: 200 });
    };
    const ok = await guardedFetch('https://api.example.com/start', {}, async () => ['93.184.216.34']);
    assert.equal(await ok.text(), 'ok');
    assert.equal(hop, 2);

    // Cross-origin redirect: refused, so a vaulted key never leaves this host.
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } });
    await assert.rejects(
      guardedFetch('https://api.example.com/start', {}, async () => ['93.184.216.34']),
      /evil\.test/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- vault: AES-GCM secrets -------------------------------------------------------

test('secrets round-trip through the vault', async () => {
  assert.equal(vaultReady(), true);
  const sealed = await lock('https://mcp.example.com|api-key-123');
  assert.ok(sealed.startsWith('v1:'), 'stored form is versioned');
  assert.ok(!sealed.includes('api-key-123'), 'the plaintext never reaches storage');
  assert.equal(await unlock(sealed), 'https://mcp.example.com|api-key-123');
});

test('a key change makes every stored secret unreadable', async () => {
  const sealed = await lock('a stored secret');
  const saved = process.env.APP_VAULT_KEY;
  process.env.APP_VAULT_KEY = 'some-other-key';
  try {
    await assert.rejects(unlock(sealed));
  } finally {
    process.env.APP_VAULT_KEY = saved;
  }
});

test('without APP_VAULT_KEY the vault refuses to store anything', async () => {
  const saved = process.env.APP_VAULT_KEY;
  delete process.env.APP_VAULT_KEY;
  try {
    assert.equal(vaultReady(), false);
    await assert.rejects(lock('secret'), /APP_VAULT_KEY/);
  } finally {
    process.env.APP_VAULT_KEY = saved;
  }
});

// --- MCP: rules, result text -------------------------------------------------------

test('read-only tools default to auto; writes can never be set to auto', () => {
  const read = { name: 'lookup', readOnly: true };
  const write = { name: 'post_row', readOnly: false };
  assert.equal(mcp.defaultRule(read), 'auto');
  assert.equal(mcp.defaultRule(write), 'ask');
  assert.equal(mcp.checkedRule(write, 'auto'), 'ask', 'the brief: writes always ask');
  assert.equal(mcp.checkedRule(write, 'off'), 'off');
  assert.equal(mcp.checkedRule(write, 'ask'), 'ask');
});

test('key headers follow the chosen sign-in style, and odd headers are refused', () => {
  assert.deepEqual(mcp.headersFor('none', 'k'), {});
  assert.deepEqual(mcp.headersFor('bearer', ''), {});
  assert.deepEqual(mcp.headersFor('bearer', 'k'), { Authorization: 'Bearer k' });
  assert.deepEqual(mcp.headersFor('header', 'k', 'X-Api-Key'), { 'X-Api-Key': 'k' });
  assert.throws(() => mcp.headersFor('header', 'k', 'Content-Type'), /won't work/);
  assert.throws(() => mcp.headersFor('header', 'k', 'Bogus Header Name'), /won't work/);
  assert.throws(() => mcp.headersFor('magic', 'k'), /sign-in type/);
});

test('tool results become readable text, capped', () => {
  assert.equal(mcp.resultText({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.equal(mcp.resultText({ content: [{ type: 'image' }] }), '[a picture]');
  assert.equal(mcp.resultText({ content: [{ type: 'resource', resource: { uri: 'file:///x' } }] }), 'file:///x');
  assert.equal(mcp.resultText({ structuredContent: { a: 1 } }), '{"a":1}');
  assert.equal(mcp.resultText({}), '(nothing came back)');
  const huge = mcp.resultText({ content: [{ type: 'text', text: 'x'.repeat(20_000) }] });
  assert.ok(huge.length < 8100 && huge.endsWith('…'), 'long results are capped');
});

// --- MCP: a live session against a local server ------------------------------------

function fakeMcpServer({ sse = false } = {}) {
  return createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'DELETE') {
        response.writeHead(200);
        return response.end();
      }
      let message = {};
      try {
        message = JSON.parse(body || '{}');
      } catch {
        response.writeHead(400);
        return response.end();
      }
      const reply = (payload) => {
        const text = JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload });
        if (sse) {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
          return response.end(`data: ${text}\n\n`);
        }
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return response.end(text);
      };
      if (message.method === 'initialize') {
        return reply({ result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0' } } });
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        return response.end();
      }
      if (message.method === 'tools/list') {
        return reply({
          result: {
            tools: [
              { name: 'lookup', description: 'Look a record up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
              { name: 'post_row', description: 'Add a row somewhere', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
            ],
          },
        });
      }
      if (message.method === 'tools/call') {
        return reply({ result: { content: [{ type: 'text', text: `found: ${message.params.arguments?.q ?? ''}` }] } });
      }
      return reply({ error: { code: -32601, message: 'unknown method' } });
    });
  });
}

const withServer = async (options, run) => {
  const server = fakeMcpServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  mcp.useFetch(fetch); // a plain fetch: the SSRF guard would (correctly) block loopback
  try {
    return await run(`http://127.0.0.1:${port}/mcp`);
  } finally {
    mcp.useFetch((input, init) => guardedFetch(input, init));
    await new Promise((resolve) => server.close(resolve));
  }
};

test('discover() lists a local MCP server\'s tools with their read/write flags', async () => {
  await withServer({}, async (url) => {
    const tools = await mcp.discover({ url, headers: {} });
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, 'lookup');
    assert.equal(tools[0].readOnly, true);
    assert.equal(tools[1].readOnly, false);
    assert.ok(tools[0].schema.properties.q, 'the JSON Schema comes along');
  });
});

test('run() calls a tool and returns its text; SSE answers are read too', async () => {
  await withServer({}, async (url) => {
    assert.equal(await mcp.run({ url, headers: {} }, 'lookup', { q: 'order-7' }), 'found: order-7');
  });
  await withServer({ sse: true }, async (url) => {
    const tools = await mcp.discover({ url, headers: {} });
    assert.equal(tools.length, 2, 'a text/event-stream response parses the same');
  });
});

test('a server that refuses the key reads back as a plain message', async () => {
  const server = createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 401, message: 'Unauthorized' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  mcp.useFetch(fetch);
  try {
    await assert.rejects(
      mcp.discover({ url: `http://127.0.0.1:${port}/mcp`, headers: {} }),
      /couldn't connect/,
      'the seller sees a plain reason, not a stack trace',
    );
  } finally {
    mcp.useFetch((input, init) => guardedFetch(input, init));
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- stored connections --------------------------------------------------------------

test('stored connections keep their key locked and honour tool rules', async () => {
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('u-mcp', 'local', 'Test Seller', 'u-mcp@example.test', Date.now());
  getDb().prepare(`
    INSERT INTO mcp_connections (id, user_id, name, host, secret, tools, rules, checked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`).run(
    'c1', 'u-mcp', 'Sheet', 'mcp.example.com',
    await lock(JSON.stringify({ url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret-key' } })),
    JSON.stringify([
      { name: 'lookup', description: 'reads rows', schema: {}, readOnly: true },
      { name: 'post_row', description: 'adds a row', schema: {}, readOnly: false },
    ]),
    Date.now(), Date.now(),
  );

  const [connection] = mcp.list('u-mcp');
  assert.equal(connection.tools.length, 2);

  // A write can't be promoted to auto, even through the API.
  const updated = mcp.setRule('u-mcp', 'c1', 'post_row', 'auto');
  assert.equal(updated.rules.post_row, 'ask');
  // Turning a tool off removes it from what recipes can see.
  mcp.setRule('u-mcp', 'c1', 'lookup', 'off');
  const keys = mcp.offers('u-mcp').map((offer) => offer.key);
  assert.deepEqual(keys.sort(), ['Sheet/post_row']);

  const stored = getDb().prepare('SELECT secret FROM mcp_connections WHERE id = ?').get('c1').secret;
  assert.ok(stored.startsWith('v1:'), 'the secret is stored locked');
  assert.ok(!stored.includes('secret-key'), 'no plaintext key in the database');

  assert.equal(mcp.remove('u-mcp', 'c1'), true);
  assert.equal(mcp.list('u-mcp').length, 0);
});
