/**
 * The tools a recipe (or Ask Byte) may reach for: SoloCart's own read and
 * write tools, joined with whatever MCP connections the seller added.
 *
 * Same rule as everywhere else in this phase: read-only tools run on their
 * own; anything that sends, changes or deletes is always the last step and
 * waits for a human's yes. `hooks/post` is how a recipe "adds a row to
 * Notion/Sheet" without an MCP server — a webhook URL accepts a JSON POST.
 */
import * as orderslib from '../orders.mjs';
import { parseWhen } from '../ai/assistant.mjs';
import { PERIODS, readPeriod, safeZone } from '../summaries/periods.mjs';
import { totals, composeTotals } from '../summaries/spending.mjs';
import { gather as briefGather, compose as composeBrief } from '../summaries/brief.mjs';
import { gather as recapGather, compose as composeRecap } from '../summaries/recap.mjs';
import { guardedFetch } from './outbound.mjs';
import * as mcp from './mcp.mjs';
import { getDb } from '../db.mjs';

/** name, description, JSON Schema, readOnly — the shape recipes' prompts show. */
const BUILT_INS = [
  {
    name: 'orders/list',
    description: "List this desk's orders as JSON (id, status, total, customer, items).",
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'draft, awaiting_buyer, captured, settled, failed, expired or paid_offline_pending' },
      },
    },
    readOnly: true,
    run: (userId, args) => {
      const rows = orderslib.listOrders(userId, args.status ? { status: String(args.status) } : {});
      return JSON.stringify(rows.map((order) => ({
        id: order.id.slice(0, 8),
        status: order.status,
        total: order.total,
        customer: order.customer || null,
        items: order.items.map((item) => `${item.quantity} x ${item.name}`),
        createdAt: new Date(order.createdAt).toISOString(),
      })), null, 1);
    },
  },
  {
    name: 'orders/totals',
    description: 'Money figures computed in code (never by the model): revenue, awaiting payment and expenses for a period.',
    schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: PERIODS, description: 'today, week, month or year (default week)' } },
    },
    readOnly: true,
    run: (userId, args) => {
      const result = totals(userId, readPeriod(args.period), new Date(), safeZone(process.env.APP_TZ));
      return `${composeTotals(result)}\n${JSON.stringify(result, null, 1)}`;
    },
  },
  {
    name: 'activity/recent',
    description: 'The latest activity events written by this desk (captures, checkouts, offline handoffs).',
    schema: { type: 'object', properties: { limit: { type: 'number', description: 'how many events, 1-50' } } },
    readOnly: true,
    run: (userId, args) => {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 15));
      const events = orderslib.listEvents(userId, limit);
      if (!events.length) return 'No activity yet.';
      return events
        .map((event) => `${new Date(event.time).toISOString()} · ${event.title}${event.amount == null ? '' : ` · $${event.amount}`} · ${event.detail || ''}`)
        .join('\n');
    },
  },
  {
    name: 'brief/morning',
    description: "The AI-free morning brief: awaiting orders, yesterday's captured money, offline confirmations to redeem, reminders due today.",
    schema: { type: 'object', properties: {} },
    readOnly: true,
    run: async (userId) => composeBrief(await briefGather(new Date(), safeZone(process.env.APP_TZ), userId)),
  },
  {
    name: 'recap/week',
    description: 'The AI-free weekly recap: what sold in the last 7 days, computed in code.',
    schema: { type: 'object', properties: {} },
    readOnly: true,
    run: async (userId) => composeRecap(await recapGather(new Date(), safeZone(process.env.APP_TZ), userId)),
  },
  {
    name: 'reminders/list',
    description: 'Reminders still due on this desk.',
    schema: { type: 'object', properties: {} },
    readOnly: true,
    run: (userId) => {
      const rows = getDb()
        .prepare('SELECT body, due_at FROM reminders WHERE user_id = ? AND done = 0 AND due_at >= ? ORDER BY due_at LIMIT 20')
        .all(userId, Date.now() - 86_400_000);
      if (!rows.length) return 'No reminders waiting.';
      return rows.map((row) => `${new Date(row.due_at).toISOString()} · ${row.body}`).join('\n');
    },
  },
  {
    name: 'reminders/add',
    description: 'Create a reminder on this desk. Changes things, so the owner confirms first.',
    schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'what to remember, max 200 characters' },
        when: { type: 'string', description: 'when: "tomorrow at 9am", "in 2 hours", or an ISO time. Default tomorrow at 9.' },
      },
      required: ['body'],
    },
    readOnly: false,
    run: (userId, args) => {
      const body = String(args.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!body) throw new Error('the reminder needs some words');
      const when = String(args.when || '').trim();
      const dueAt = when
        ? (Number.isFinite(Date.parse(when)) ? Date.parse(when) : Date.parse(parseWhen(when.toLowerCase())))
        : Date.parse(parseWhen('tomorrow at 9am'));
      if (!Number.isFinite(dueAt)) throw new Error('could not read that time');
      const id = crypto.randomUUID();
      getDb().prepare('INSERT INTO reminders (id, user_id, body, due_at, done, order_id, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)')
        .run(id, userId, body, dueAt, Date.now());
      return `Reminder set for ${new Date(dueAt).toISOString()}: ${body}`;
    },
  },
  {
    name: 'hooks/post',
    description: 'POST a JSON body to a public https webhook URL (a Notion webhook, a Google Apps Script web app, a Zapier hook). '
      + 'Changes things, so the owner confirms first. No custom headers: the URL carries the auth, or connect an MCP server for richer APIs.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the full https:// webhook address' },
        json: { type: 'string', description: 'the JSON body to send, as a JSON string' },
      },
      required: ['url', 'json'],
    },
    readOnly: false,
    run: async (userId, args, { fetchImpl = guardedFetch } = {}) => {
      let payload;
      try {
        payload = typeof args.json === 'string' ? JSON.parse(args.json) : args.json;
      } catch {
        throw new Error('the body was not valid JSON');
      }
      const response = await fetchImpl(String(args.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = (await response.text().catch(() => '')).slice(0, 500);
      if (!response.ok) throw new Error(`the server answered ${response.status}: ${text || '(no body)'}`);
      return `Sent. The server answered ${response.status}${text ? `: ${text}` : '.'}`;
    },
  },
];

/** Every tool available to this seller: SoloCart's own plus their MCP connections. */
export function offers(userId) {
  return [
    ...BUILT_INS.map((tool) => ({
      key: tool.name,
      kind: 'builtin',
      userId,
      tool,
      rule: tool.readOnly ? 'auto' : 'ask',
    })),
    ...mcp.offers(userId),
  ];
}

/** Runs a chosen (or approved) tool and returns its text. */
export async function use(offer, args, asked) {
  if (offer.kind === 'mcp') return mcp.use(offer, args, asked);
  const tool = BUILT_INS.find((entry) => entry.name === offer.tool.name);
  if (!tool) throw new Error('that tool is gone');
  try {
    return await tool.run(offer.userId ?? null, args ?? {}, {});
  } catch (error) {
    throw new Error(String(error?.message || error).slice(0, 500));
  }
}
