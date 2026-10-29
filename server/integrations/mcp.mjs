/**
 * MCP connections — port of Butler's `mcp.ts` onto plain Node, with the
 * official SDK replaced by a small Streamable-HTTP JSON-RPC client (the brief
 * keeps runtime dependencies to the noble crypto pair).
 *
 * A connection is a public MCP server (Zapier, Notion, your own) that the
 * seller adds by link and key. Read-only tools run on their own; anything
 * that could send, change or delete waits for the seller's yes. The link and
 * key are stored only vault-locked, never in plaintext.
 */
import { checkUrl, guardedFetch } from './outbound.mjs';
import { lock, unlock } from './vault.mjs';
import { getDb } from '../db.mjs';

export const RULES = ['auto', 'ask', 'off'];

export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const HEADER_RE = /^[A-Za-z0-9-]{1,60}$/;
const CONNECT_MS = 20_000;
const CALL_MS = 60_000;
const MAX_TOOLS = 100;
const MAX_RESULT = 8_000;
const PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'];

let fetcher = (input, init) => guardedFetch(input, init);

/** Swaps the fetch used to reach servers (tests use a plain one, to reach a local server). */
export const useFetch = (f) => { fetcher = f; };

/** How the server wants its key: "none", "bearer" or a named header. */
export function headersFor(auth, key, header = '') {
  if (auth === 'none' || !key) return {};
  if (auth === 'bearer') return { Authorization: `Bearer ${key}` };
  if (auth === 'header') {
    if (!HEADER_RE.test(header) || /^(host|content-type|content-length|accept|cookie)$/i.test(header)) {
      throw new Error('that header name won\'t work');
    }
    return { [header]: key };
  }
  throw new Error('unknown sign-in type');
}

/** The rule a tool gets until the seller chooses: reads run, writes ask. */
export const defaultRule = (tool) => (tool.readOnly ? 'auto' : 'ask');

/** Writes may only be `ask` or `off` — they always wait for a human here. */
export const checkedRule = (tool, rule) => (!tool.readOnly && rule === 'auto' ? 'ask' : rule);

const ruleFor = (connection, tool) => connection.rules?.[tool.name] ?? defaultRule(tool);

function plainError(error) {
  const text = error instanceof Error ? error.message : String(error);
  const code = error?.code;
  if (code === 401 || /\b401\b|unauthori[sz]ed/i.test(text)) return 'the server said the key is wrong or missing';
  if (code === 403 || /\b403\b|forbidden/i.test(text)) return 'the server refused SoloCart';
  if (code === 404 || /\b404\b/.test(text)) return 'nothing at that address; check the link';
  return text.slice(0, 200);
}

// --- a small Streamable HTTP / SSE client --------------------------------------

function parseRpcResponse(response, text) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    const messages = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .map((chunk) => { try { return JSON.parse(chunk); } catch { return null; } })
      .filter((entry) => entry && (entry.result !== undefined || entry.error !== undefined));
    if (!messages.length) throw new Error('the server sent an empty stream');
    return messages[0];
  }
  if (!text.trim()) throw new Error('the server sent an empty answer');
  return JSON.parse(text);
}

class McpSession {
  constructor(url, headers) {
    this.url = url;
    this.headers = headers;
    this.session = null;
    this.nextId = 1;
    this.protocol = PROTOCOL_VERSIONS[0];
  }

  async request(method, params, { notification = false, timeoutMs = CONNECT_MS } = {}) {
    const headers = {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const body = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: this.nextId++, method, params };

    const response = await fetcher(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.session = session;

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const error = new Error(`${response.status} ${text.slice(0, 200)}`);
      error.code = response.status;
      throw error;
    }
    if (notification) return null;
    const message = parseRpcResponse(response, text);
    if (message.error) {
      const error = new Error(String(message.error.message || 'the server reported an error'));
      error.code = message.error.code;
      throw error;
    }
    return message.result;
  }

  /** Server's farewell: best effort, and never an error to the caller. */
  async close() {
    if (!this.session) return;
    try {
      const headers = { ...this.headers, 'mcp-session-id': this.session };
      await fetcher(this.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) });
    } catch {
      // Servers that don't end sessions simply ignore this.
    }
  }
}

/** Opens a session: initialize (+ notification), retrying once on protocol version. */
async function open(secret) {
  let first = null;
  for (const protocol of PROTOCOL_VERSIONS) {
    const session = new McpSession(secret.url, secret.headers);
    session.protocol = protocol;
    try {
      await session.request('initialize', {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: 'SoloCart', version: '1.0' },
      });
      await session.request('notifications/initialized', {}, { notification: true });
      return session;
    } catch (error) {
      first ??= error;
      await session.close();
    }
  }
  throw new Error(`couldn't connect: ${plainError(first)}`);
}

/** What a tool sent back, as text you could read. */
export function resultText(result) {
  const parts = (Array.isArray(result?.content) ? result.content : [])
    .map((entry) => {
      if (entry?.type === 'text') return entry.text || '';
      if (entry?.type === 'resource') return entry.resource?.text || entry.resource?.uri || '';
      if (entry?.type === 'image') return '[a picture]';
      if (entry?.type === 'audio') return '[a sound clip]';
      if (entry?.type === 'resource_link') return String(entry.uri || '');
      return '';
    })
    .filter(Boolean);
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n').trim() || '(nothing came back)';
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…` : text;
}

/** The tools the server offers. */
export async function discover(secret) {
  const session = await open(secret);
  try {
    const tools = [];
    let cursor;
    do {
      const page = await session.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: CONNECT_MS });
      for (const tool of page.tools || []) {
        tools.push({
          name: tool.name,
          description: String(tool.description || tool.title || '').slice(0, 1000),
          schema: tool.inputSchema || {},
          readOnly: tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS);
    return tools.slice(0, MAX_TOOLS);
  } finally {
    await session.close();
  }
}

/** Runs one tool. Throws with the server's words if the tool failed. */
export async function run(secret, tool, args) {
  const session = await open(secret);
  try {
    const result = await session.request('tools/call', { name: tool, arguments: args }, { timeoutMs: CALL_MS });
    const text = resultText(result);
    if (result?.isError) throw new Error(text.slice(0, 500));
    return text;
  } finally {
    await session.close();
  }
}

// --- stored connections ---------------------------------------------------------

const COLUMNS = 'id, name, host, tools, rules, checked_at, error';

const mapRow = (row) => ({
  id: row.id,
  name: row.name,
  host: row.host,
  tools: JSON.parse(row.tools || '[]'),
  rules: JSON.parse(row.rules || '{}'),
  checkedAt: row.checked_at,
  error: row.error,
});

export const list = (userId) => getDb()
  .prepare(`SELECT ${COLUMNS} FROM mcp_connections WHERE user_id = ? ORDER BY created_at`)
  .all(userId)
  .map(mapRow);

export const find = (userId, id) => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM mcp_connections WHERE user_id = ? AND id = ?`).get(userId, id);
  return row ? mapRow(row) : null;
};

async function secretOf(id) {
  const row = getDb().prepare('SELECT secret FROM mcp_connections WHERE id = ?').get(id);
  if (!row) throw new Error('that connection is gone');
  return JSON.parse(await unlock(row.secret));
}

/** Checks the link, connects, and keeps the connection with the tools it offers. */
export async function add(userId, name, link, { auth = 'none', key = '', header = '' } = {}) {
  if (!NAME_RE.test(name)) throw new Error('give it a short name: letters, numbers, spaces, . _ -');
  const url = await checkUrl(link);
  const secret = { url: url.href, headers: headersFor(auth, key, header) };
  const tools = await discover(secret);
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO mcp_connections (id, user_id, name, host, secret, tools, rules, checked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`).run(
    id, userId, name.trim(), url.host, await lock(JSON.stringify(secret)),
    JSON.stringify(tools), Date.now(), Date.now(),
  );
  return find(userId, id);
}

/** Asks the server again which tools it has; a failure keeps the old list. */
export async function refresh(userId, id) {
  const connection = find(userId, id);
  if (!connection) throw new Error('that connection is gone');
  let tools = null;
  let error = null;
  try {
    tools = await discover(await secretOf(id));
  } catch (caught) {
    error = String(caught?.message || caught).slice(0, 300);
  }
  getDb().prepare('UPDATE mcp_connections SET tools = ?, checked_at = ?, error = ? WHERE user_id = ? AND id = ?').run(
    JSON.stringify(tools ?? connection.tools), Date.now(), error, userId, id,
  );
  return find(userId, id);
}

/** One tool's rule (`auto` only ever offered for read-only tools). */
export function setRule(userId, id, toolName, rule) {
  const connection = find(userId, id);
  if (!connection) throw new Error('that connection is gone');
  const tool = connection.tools.find((entry) => entry.name === toolName);
  if (!tool) throw new Error('that tool is not offered by this connection');
  const checked = checkedRule(tool, rule);
  if (!RULES.includes(checked)) throw new Error('choose auto, ask or off');
  connection.rules[toolName] = checked;
  getDb().prepare('UPDATE mcp_connections SET rules = ? WHERE user_id = ? AND id = ?')
    .run(JSON.stringify(connection.rules), userId, id);
  return connection;
}

export const remove = (userId, id) =>
  getDb().prepare('DELETE FROM mcp_connections WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;

// --- using tools from recipes / Ask Byte ----------------------------------------

/** Every tool that isn't switched off, keyed "Connection/tool". */
export function offers(userId) {
  return list(userId).flatMap((connection) => {
    connection.userId = userId; // carried for the call log
    return connection.tools
      .map((tool) => ({
        key: `${connection.name}/${tool.name}`,
        kind: 'mcp',
        connection,
        tool,
        rule: ruleFor(connection, tool),
      }))
      .filter((offer) => offer.rule !== 'off');
  });
}

/** Runs a tool the seller chose (or said yes to), and writes it in the log. */
export async function use(offer, args, asked) {
  let status = 'done';
  let result;
  try {
    result = await run(await secretOf(offer.connection.id), offer.tool.name, args);
    return result;
  } catch (error) {
    status = 'failed';
    result = plainError(error);
    throw new Error(result);
  } finally {
    try {
      getDb().prepare(`
        INSERT INTO mcp_calls (user_id, connection_id, connection, tool, args, asked, status, result, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        offer.connection.userId ?? null,
        offer.connection.id,
        offer.connection.name,
        offer.tool.name,
        JSON.stringify(args ?? {}),
        asked ? 1 : 0,
        status,
        String(result ?? '').slice(0, 2000),
        Date.now(),
      );
    } catch (logged) {
      console.error('mcp log', String(logged?.message || logged).slice(0, 200));
    }
  }
}

export const recentCalls = (userId, limit = 30) => getDb()
  .prepare('SELECT at, connection, tool, args, asked, status, result FROM mcp_calls WHERE user_id = ? ORDER BY at DESC LIMIT ?')
  .all(userId, limit)
  .map((row) => ({ ...row, args: JSON.parse(row.args || '{}'), asked: Boolean(row.asked) }));
