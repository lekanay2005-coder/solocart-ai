/**
 * SoloCart — thin entry point.
 *
 * Loads config, opens the database, wires the router and static files, and
 * listens. All behaviour lives in ./server/*:
 *
 *   db.mjs       SQLite + numbered migrations
 *   auth.mjs     scrypt accounts, hashed-token sessions, device identity
 *   paypal.mjs   Sandbox-only PayPal: token cache, capture, webhook verify
 *   orders.mjs   order state machine, totals, activity feed
 *   http.mjs     wire helpers and structured errors
 *   ratelimit.mjs per-IP and per-account budgets
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb, rootDir } from './server/db.mjs';
import * as auth from './server/auth.mjs';
import * as paypal from './server/paypal.mjs';
import * as orderslib from './server/orders.mjs';
import * as assistant from './server/ai/assistant.mjs';
import * as memory from './server/ai/memory.mjs';
import * as offline from './server/offline/ledger.mjs';
import { extract } from './server/ai/orders.mjs';
import { activeLabel, providerStatus, providersReady } from './server/ai/providers.mjs';
import { composeTotals, totals } from './server/summaries/spending.mjs';
import { readPeriod, safeZone, localIso } from './server/summaries/periods.mjs';
import * as brief from './server/summaries/brief.mjs';
import * as recap from './server/summaries/recap.mjs';
import * as streaks from './server/summaries/streaks.mjs';
import * as recipes from './server/integrations/recipes.mjs';
import * as jobs from './server/integrations/jobs.mjs';
import * as mcp from './server/integrations/mcp.mjs';
import * as tools from './server/integrations/tools.mjs';
import { vaultReady } from './server/integrations/vault.mjs';
import {
  HttpError,
  deviceCookie,
  readJson,
  redirect,
  sameOrigin,
  sendError,
  sendJson,
  sessionCookie,
  setSecurityHeaders,
} from './server/http.mjs';
import { limitByIp, limitByUser, loginLimiter } from './server/ratelimit.mjs';

await loadEnv(join(rootDir, '.env'));

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const appBaseUrl = (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const publicRoot = join(rootDir, 'public');
const hasPaypal = paypal.isPaypalConfigured();

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// --- boot -----------------------------------------------------------------------

getDb(); // opens data/solocart.db and applies pending migrations
auth.migrateLegacyUsers();
auth.purgeExpiredSessions();
orderslib.expireStaleOrders();

const sweeper = setInterval(() => {
  try {
    orderslib.expireStaleOrders();
    auth.purgeExpiredSessions();
    memory.pruneTurns();
    runScheduledJobs();
  } catch (error) {
    console.error('[sweeper]', error?.message || error);
  }
}, 60_000);
sweeper.unref();

/** Phase 4: due schedules become recipe jobs, and the job queue drains. */
function runScheduledJobs() {
  const local = localIso(new Date(), safeZone(process.env.APP_TZ));
  for (const recipe of recipes.claimDue(local)) {
    recipes.start(recipe.userId, recipe.id, { trigger: 'schedule' });
  }
  jobs.tick().catch((error) => console.error('[jobs]', error?.message || error));
}

// Catch up schedules that came due while the server was down (within the
// 3-hour window), then let the every-minute sweeper take over.
setTimeout(runScheduledJobs, 3_000).unref();

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendError(response, error);
  });
});

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`SoloCart is ready at http://${shown}:${port}`);
  console.log(`  PayPal: ${hasPaypal ? 'Sandbox credentials found' : 'preview (add PAYPAL_CLIENT_ID/SECRET to enable Sandbox)'}`);
  console.log(`  AI:     ${activeLabel() || 'local parser + rules (add OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY)'}`);
});

// --- router ---------------------------------------------------------------------

async function handle(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  setSecurityHeaders(response);

  if (url.pathname === '/healthz') return sendJson(response, 200, health());
  if (url.pathname === '/paypal/webhook') return handleWebhook(request, response);
  // Recipe webhooks sit outside /api/: their callers are external services,
  // so the same-origin rule doesn't apply — the secret token is the check.
  if (url.pathname.startsWith('/hooks/')) return handleRecipeHook(request, response, url);
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
  if (url.pathname === '/paypal/return' || url.pathname === '/paypal/cancel') {
    return handlePaypalReturn(request, response, url);
  }
  return serveStatic(request, response, url);
}

function health() {
  let database = 'ok';
  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    database = 'unavailable';
  }
  return {
    status: database === 'ok' ? 'ok' : 'degraded',
    database,
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    paypal: hasPaypal ? 'sandbox' : 'preview',
    ai: providersReady() ? 'configured' : 'local',
    webhook: paypal.webhookConfigured() ? 'configured' : 'not_configured',
  };
}

/** Every API route: same-origin check, per-IP budget, then dispatch. */
async function handleApi(request, response, url) {
  if (!sameOrigin(request)) throw new HttpError(403, 'Requests must come from this app.', 'origin');
  if (!limitByIp(request)) {
    return sendJson(response, 429, { error: 'Too many requests. Wait a moment and try again.', code: 'rate_limited' });
  }

  const path = url.pathname;
  const method = request.method || 'GET';

  if (path === '/api/config' && method === 'GET') {
    const providers = providerStatus();
    const live = providers.find((entry) => entry.live) || null;
    return sendJson(response, 200, {
      // 'provider' means at least one AI provider is configured; 'local' means
      // rules and the local parser only. Keys themselves are never returned.
      aiMode: providersReady() ? 'provider' : 'local',
      aiLabel: activeLabel() || 'Local parser',
      aiProvider: live ? live.id : null,
      providers,
      paypalMode: hasPaypal ? 'sandbox' : 'preview',
      model: live ? live.model : null,
      webhook: paypal.webhookConfigured() ? 'configured' : 'not_configured',
    });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const user = auth.requestSessionUser(request);
    return sendJson(response, 200, { user: user ? auth.publicUser(user) : null });
  }
  if (path === '/api/auth/register' && method === 'POST') return registerUser(request, response);
  if (path === '/api/auth/login' && method === 'POST') return loginUser(request, response);
  if (path === '/api/auth/logout' && method === 'POST') {
    auth.deleteSession(readSessionToken(request));
    appendCookie(response, sessionCookie(appBaseUrl, '', true));
    return sendJson(response, 200, { ok: true });
  }

  if (path === '/api/parse-order' && method === 'POST') return parseOrder(request, response);
  if (path === '/api/create-checkout' && method === 'POST') return createCheckout(request, response);

  if (path === '/api/orders' && method === 'GET') {
    const user = attachIdentity(request, response);
    if (!limitByUser(user.id)) return tooMany(response);
    return sendJson(response, 200, { orders: orderslib.listOrders(user.id).map(publicOrder) });
  }
  if (path === '/api/activity' && method === 'GET') {
    const user = attachIdentity(request, response);
    if (!limitByUser(user.id)) return tooMany(response);
    return sendJson(response, 200, {
      events: orderslib.listEvents(user.id),
      summary: orderslib.activitySummary(user.id),
    });
  }

  if (path === '/api/totals' && method === 'GET') {
    const user = attachIdentity(request, response);
    const period = readPeriod(url.searchParams.get('period'));
    const result = totals(user.id, period, new Date(), safeZone(process.env.APP_TZ));
    return sendJson(response, 200, { ...result, text: composeTotals(result) });
  }

  if (path === '/api/facts' && method === 'GET') {
    const user = attachIdentity(request, response);
    return sendJson(response, 200, { facts: memory.listFacts(user.id) });
  }
  if (path === '/api/facts/forget-all' && method === 'POST') {
    const user = attachIdentity(request, response);
    return sendJson(response, 200, { forgotten: memory.forgetAllFacts(user.id) });
  }
  if (path.startsWith('/api/facts/') && method === 'DELETE') {
    const user = attachIdentity(request, response);
    const forgotten = memory.forgetFact(user.id, path.slice('/api/facts/'.length));
    if (!forgotten) throw new HttpError(404, 'That fact is already gone.', 'not_found');
    return sendJson(response, 200, { forgotten: 1 });
  }

  if (path === '/api/ask' && method === 'POST') return askByte(request, response);
  if (path === '/api/ask/confirm' && method === 'POST') return confirmAsk(request, response);

  // Phase 4: automation (Butler port).
  if (path === '/api/report' && method === 'GET') return sendReport(request, response);
  if (path === '/api/recipes' && method === 'GET') return listRecipes(request, response);
  if (path === '/api/recipes' && method === 'POST') return saveRecipeRoute(request, response);
  if (path === '/api/recipes/runs' && method === 'GET') return listRecipeRuns(request, response);
  if (path.startsWith('/api/recipes/approvals/') && method === 'POST') {
    return approveRecipeRun(request, response, path.slice('/api/recipes/approvals/'.length));
  }
  if (path.startsWith('/api/recipes/') && path.endsWith('/run') && method === 'POST') {
    return runRecipe(request, response, path.slice('/api/recipes/'.length, -'/run'.length));
  }
  if (path.startsWith('/api/recipes/') && path.endsWith('/hook') && method === 'POST') {
    return makeRecipeHook(request, response, path.slice('/api/recipes/'.length, -'/hook'.length));
  }
  if (path.startsWith('/api/recipes/') && path.endsWith('/hook') && method === 'DELETE') {
    return dropRecipeHook(request, response, path.slice('/api/recipes/'.length, -'/hook'.length));
  }
  if (path.startsWith('/api/recipes/') && method === 'DELETE') {
    return deleteRecipe(request, response, path.slice('/api/recipes/'.length));
  }
  if (path === '/api/integrations' && method === 'GET') return listIntegrations(request, response);
  if (path === '/api/integrations' && method === 'POST') return addIntegration(request, response);
  if (path === '/api/integrations/calls' && method === 'GET') return listIntegrationCalls(request, response);
  if (path.startsWith('/api/integrations/') && path.endsWith('/refresh') && method === 'POST') {
    return refreshIntegration(request, response, path.slice('/api/integrations/'.length, -'/refresh'.length));
  }
  if (path.startsWith('/api/integrations/') && path.endsWith('/rules') && method === 'POST') {
    return setIntegrationRule(request, response, path.slice('/api/integrations/'.length, -'/rules'.length));
  }
  if (path.startsWith('/api/integrations/') && method === 'DELETE') {
    return deleteIntegration(request, response, path.slice('/api/integrations/'.length));
  }

  // Phase 3: offline payments (Morrow port).
  if (path === '/api/offline/request' && method === 'POST') return issueOfflineRequest(request, response);
  if (path === '/api/offline/requests' && method === 'GET') return listOfflineRequests(request, response);
  if (path.startsWith('/api/offline/share/') && method === 'GET') {
    return shareOfflineRequest(response, path.slice('/api/offline/share/'.length));
  }
  if (path === '/api/offline/confirm' && method === 'POST') return confirmOfflinePayment(request, response);
  if (path === '/api/offline/redeem' && method === 'POST') return redeemOfflinePayment(request, response);

  throw new HttpError(404, 'Not found.', 'not_found');
}

/**
 * Ask Byte: one message in, one plan out. Read actions answer immediately;
 * write actions come back with `needsConfirm` and a short-lived token, and
 * nothing happens until the seller confirms.
 */
async function askByte(request, response) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) throw new HttpError(400, 'Type a question or a command for Byte first.', 'invalid_input');

  const plan = await assistant.plan(user.id, text);
  // Facts are learned immediately but stay fully visible and deletable in
  // Settings; secrets are dropped by cleanFact before they ever land.
  const learned = plan.remember?.length ? memory.remember(user.id, plan.remember) : [];
  if (assistant.WRITE_ACTIONS.has(plan.action)) {
    const token = assistant.parkPlan(user.id, plan);
    assistant.rememberExchange(user.id, text, plan.reply);
    return sendJson(response, 200, { plan, needsConfirm: true, token, remembered: learned });
  }
  const result = await assistant.execute(user.id, plan);
  assistant.rememberExchange(user.id, text, result.reply);
  return sendJson(response, 200, { plan, needsConfirm: false, reply: result.reply, data: result.data || null, remembered: learned });
}

/** The confirm click: the only way a write action ever runs. */
async function confirmAsk(request, response) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  const plan = assistant.takePlan(String(body.token || ''), user.id);
  if (!plan) throw new HttpError(410, 'That confirmation expired — ask again and confirm while it is fresh.', 'plan_expired');
  if (body.confirm !== true) {
    assistant.rememberExchange(user.id, null, 'Cancelled — nothing changed.');
    return sendJson(response, 200, { cancelled: true, reply: 'Cancelled. Nothing was changed.' });
  }
  const result = await assistant.execute(user.id, plan);
  assistant.rememberExchange(user.id, null, result.reply);
  return sendJson(response, 200, { plan, needsConfirm: false, reply: result.reply, data: result.data || null });
}

const tooMany = (response) =>
  sendJson(response, 429, { error: 'Too many requests. Wait a moment and try again.', code: 'rate_limited' });

/** The owner never needs their own row's internal owner id echoed back. */
function publicOrder(order) {
  const { userId, ...rest } = order;
  return rest;
}

/**
 * The request's owner: the signed-in account, or a transparent device user
 * created (and cookie'd) on first use so the desk works without sign-in.
 */
function attachIdentity(request, response) {
  const { user, isNewDevice } = auth.ensureIdentity(request);
  if (isNewDevice) appendCookie(response, deviceCookie(appBaseUrl, user.id));
  if (!limitByUser(user.id)) {
    throw new HttpError(429, 'Too many requests. Wait a moment and try again.', 'rate_limited');
  }
  return user;
}

function appendCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie');
  if (!existing) response.setHeader('Set-Cookie', cookie);
  else response.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [String(existing)]), cookie]);
}

const readSessionToken = (request) => cookieValue(request, 'sc_session');

function cookieValue(request, name) {
  return String(request.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || '';
}

// --- offline payment routes (phase 3) -------------------------------------------

/** Seller: issue a signed payment request for one of their draft orders. */
async function issueOfflineRequest(request, response) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  const order = orderslib.getOrder(user.id, String(body.orderId || ''));
  if (!order) throw new HttpError(404, 'Pick a draft order to issue a request for.', 'not_found');

  const issued = offline.issueRequest(user, order);
  orderslib.addEvent(user.id, {
    kind: 'offline',
    title: 'Offline payment request issued',
    detail: `${issued.requestId} · share the payment link with the buyer`,
    amount: issued.amount,
  });
  return sendJson(response, 201, {
    requestId: issued.requestId,
    orderId: issued.orderId,
    payload: issued.payload,
    request: issued.request,
    status: issued.status,
    expiresAt: issued.expiresAt,
    payUrl: `/pay.html?r=${issued.requestId}`,
    notice: 'The buyer opens this link (or pastes the payload) and pays from their Reserve — that step needs no connectivity.',
  });
}

async function listOfflineRequests(request, response) {
  const user = attachIdentity(request, response);
  return sendJson(response, 200, { requests: offline.listRequests(user.id) });
}

/** Public read for the buyer page: the request body and its current state. */
function shareOfflineRequest(response, requestId) {
  const shared = offline.findShare(requestId);
  if (!shared) throw new HttpError(404, 'That offline request does not exist.', 'not_found');
  return sendJson(response, 200, shared);
}

/** Buyer: hand over the signed confirmation. Verified here, never settled here. */
async function confirmOfflinePayment(request, response) {
  attachIdentity(request, response); // rate budget for the public handoff
  const body = await readJson(request);
  const result = await offline.confirm({
    requestId: String(body.requestId || ''),
    confirmationInput: body.confirmation ?? body.payload ?? null,
  });
  return sendJson(response, 200, {
    verified: true,
    requestId: result.requestId,
    status: 'confirmed',
    settlement: 'pending',
    notice: offline.CONFIRM_NOTICE,
  });
}

/** Seller: redeem the verified confirmation — the only path to `settled`. */
async function redeemOfflinePayment(request, response) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  const before = streaks.lifetimeRevenue(user.id);
  const result = await offline.redeem(user, String(body.requestId || ''));
  noteMilestones(user.id, before);
  recipes.onOrderEvent(user.id, 'order.settled',
    `Event: order event\nRequest ${result.requestId} redeemed over ${result.channel} — order moved to settled (settlement simulated, see docs/OFFLINE_PAYMENTS.md).`);
  return sendJson(response, 200, {
    redeemed: true,
    requestId: result.requestId,
    status: 'redeemed',
    channel: result.channel,
    notice: result.notice,
  });
}

// --- automation routes (phase 4) ---------------------------------------------------

function ownedRecipe(user, id) {
  const recipe = recipes.byId(user.id, id);
  if (!recipe) throw new HttpError(404, 'That recipe does not exist.', 'not_found');
  return recipe;
}

async function listRecipes(request, response) {
  const user = attachIdentity(request, response);
  return sendJson(response, 200, {
    recipes: recipes.list(user.id).map((recipe) => ({ ...recipe, schedule: recipes.describeSchedule(recipe) })),
    pending: recipes.pendingRuns(user.id),
    runs: recipes.recentRuns(user.id, 15),
    jobs: jobs.recentJobs(user.id, 10),
    // Recipes plan their steps with an AI provider; without one, runs fail
    // visibly in Runs history rather than pretending.
    ai: providersReady(),
    vault: vaultReady() ? 'ready' : 'missing_key',
    orderEvents: recipes.ORDER_EVENTS,
    tools: tools.offers(user.id).map((offer) => ({
      key: offer.key,
      kind: offer.kind,
      readOnly: offer.tool.readOnly,
      description: offer.tool.description,
      rule: offer.rule,
    })),
  });
}

async function listRecipeRuns(request, response) {
  const user = attachIdentity(request, response);
  return sendJson(response, 200, {
    runs: recipes.recentRuns(user.id, 30),
    pending: recipes.pendingRuns(user.id),
    jobs: jobs.recentJobs(user.id, 20),
  });
}

async function saveRecipeRoute(request, response) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  const id = String(body.id || '') || null;
  try {
    const recipe = recipes.save(user.id, id, {
      name: body.name,
      instructions: body.instructions,
      trigger: body.trigger || 'manual',
      config: body.config || {},
    });
    return sendJson(response, id ? 200 : 201, {
      recipe: { ...recipe, schedule: recipes.describeSchedule(recipe) },
    });
  } catch (error) {
    // save() validates in plain words; those are the seller's mistakes, not 500s.
    throw new HttpError(400, String(error?.message || error), 'invalid_recipe');
  }
}

async function deleteRecipe(request, response, id) {
  const user = attachIdentity(request, response);
  if (!recipes.remove(user.id, id)) throw new HttpError(404, 'That recipe does not exist.', 'not_found');
  return sendJson(response, 200, { deleted: 1 });
}

async function runRecipe(request, response, id) {
  const user = attachIdentity(request, response);
  const recipe = ownedRecipe(user, id);
  recipes.start(user.id, recipe.id, { trigger: 'manual' });
  return sendJson(response, 202, {
    queued: true,
    recipe: recipe.name,
    notice: providersReady()
      ? 'Run queued — watch it in Runs; a write step will wait for your approval.'
      : 'Run queued, but no AI provider is configured: it will fail with that message in Runs.',
  });
}

async function makeRecipeHook(request, response, id) {
  const user = attachIdentity(request, response);
  const recipe = ownedRecipe(user, id);
  let token;
  try {
    token = await recipes.makeHook(user.id, recipe.id);
  } catch (error) {
    throw new HttpError(503, String(error?.message || error), 'vault_unconfigured');
  }
  return sendJson(response, 200, {
    token,
    url: `${appBaseUrl}/hooks/${token}`,
    hasHook: true,
    notice: 'Anyone holding this link can start the recipe (rate-limited). Shown once — regenerate it if it leaks.',
  });
}

async function dropRecipeHook(request, response, id) {
  const user = attachIdentity(request, response);
  ownedRecipe(user, id);
  recipes.dropHook(user.id, id);
  return sendJson(response, 200, { hasHook: false });
}

/** The confirm/decline click: the only way a recipe's write step ever runs. */
async function approveRecipeRun(request, response, runId) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  try {
    const result = await recipes.approve(user.id, String(runId || ''), body.confirm === true);
    return sendJson(response, 200, result);
  } catch (error) {
    const message = String(error?.message || error);
    if (/is gone/.test(message)) throw new HttpError(404, 'That run is gone.', 'not_found');
    if (/already finished|no longer available/.test(message)) throw new HttpError(409, message, 'run_closed');
    // The write was attempted and failed; the run row already says so.
    throw new HttpError(400, message, 'approval_failed');
  }
}

/** The desk report: morning brief, weekly recap, streak and milestones — all AI-free. */
async function sendReport(request, response) {
  const user = attachIdentity(request, response);
  const now = new Date();
  const timeZone = safeZone(process.env.APP_TZ);
  const briefParts = brief.gather(now, timeZone, user.id);
  const week = recap.gather(now, timeZone, user.id);
  const lifetime = streaks.lifetimeRevenue(user.id);
  const days = streaks.streak(streaks.saleDays(user.id, timeZone), brief.todayIn(now, timeZone));
  const reachedDollars = streaks.MILESTONE_DOLLARS.filter((value) => lifetime.revenue >= value);
  const reachedOrders = streaks.MILESTONE_ORDERS.filter((value) => lifetime.count >= value);
  return sendJson(response, 200, {
    brief: { text: brief.compose(briefParts, now, timeZone), parts: briefParts },
    recap: { text: recap.compose(week) },
    lifetime,
    streak: {
      days,
      note: days >= 2 ? streaks.streakNote(days) : '',
      cheering: streaks.streakWorthCheering(days),
    },
    milestones: {
      reached: { dollars: reachedDollars, orders: reachedOrders },
      next: {
        dollars: streaks.MILESTONE_DOLLARS.find((value) => value > lifetime.revenue) ?? null,
        orders: streaks.MILESTONE_ORDERS.find((value) => value > lifetime.count) ?? null,
      },
    },
  });
}

// --- integrations routes (phase 4) ------------------------------------------------

async function listIntegrations(request, response) {
  const user = attachIdentity(request, response);
  return sendJson(response, 200, {
    connections: mcp.list(user.id),
    calls: mcp.recentCalls(user.id, 15),
    vault: vaultReady() ? 'ready' : 'missing_key',
    rules: mcp.RULES,
  });
}

async function listIntegrationCalls(request, response) {
  const user = attachIdentity(request, response);
  return sendJson(response, 200, { calls: mcp.recentCalls(user.id, 30) });
}

async function addIntegration(request, response) {
  const user = attachIdentity(request, response);
  if (!vaultReady()) {
    throw new HttpError(503, 'Set APP_VAULT_KEY in .env before storing connection keys.', 'vault_unconfigured');
  }
  const body = await readJson(request);
  try {
    const connection = await mcp.add(user.id, String(body.name || ''), String(body.url || ''), {
      auth: String(body.auth || 'none'),
      key: String(body.key || ''),
      header: String(body.header || ''),
    });
    return sendJson(response, 201, { connection });
  } catch (error) {
    const message = String(error?.message || error);
    if (/public addresses|https:\/\/|isn't a web address|password in the key box/.test(message)) {
      throw new HttpError(400, message, 'blocked_address');
    }
    throw new HttpError(400, message, 'connect_failed');
  }
}

async function deleteIntegration(request, response, id) {
  const user = attachIdentity(request, response);
  if (!mcp.remove(user.id, id)) throw new HttpError(404, 'That connection does not exist.', 'not_found');
  return sendJson(response, 200, { deleted: 1 });
}

async function refreshIntegration(request, response, id) {
  const user = attachIdentity(request, response);
  try {
    const connection = await mcp.refresh(user.id, id);
    return sendJson(response, 200, { connection });
  } catch (error) {
    if (/gone/.test(String(error?.message))) throw new HttpError(404, 'That connection does not exist.', 'not_found');
    throw error;
  }
}

async function setIntegrationRule(request, response, id) {
  const user = attachIdentity(request, response);
  const body = await readJson(request);
  try {
    const connection = mcp.setRule(user.id, id, String(body.tool || ''), String(body.rule || ''));
    return sendJson(response, 200, { connection });
  } catch (error) {
    const message = String(error?.message || error);
    if (/gone/.test(message)) throw new HttpError(404, 'That connection does not exist.', 'not_found');
    throw new HttpError(400, message, 'bad_rule');
  }
}

/**
 * A recipe's secret link: external services call it (so it lives outside the
 * same-origin rule — the token is the check), rate-limited per IP and per
 * recipe, and the body is passed as data for the recipe to work on.
 */
async function handleRecipeHook(request, response, url) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'method');
  if (!limitByIp(request)) {
    return sendJson(response, 429, { error: 'Too many requests. Wait a moment and try again.', code: 'rate_limited' });
  }
  const token = url.pathname.slice('/hooks/'.length);
  const recipe = await recipes.byHook(token);
  if (!recipe) throw new HttpError(404, 'No recipe for that link.', 'not_found');
  const body = await readJson(request, 8000).catch(() => ({}));
  if (!recipes.limits.allow(recipe.id)) {
    return sendJson(response, 429, { queued: false, reason: 'This recipe was started too recently.' });
  }
  recipes.start(recipe.userId, recipe.id, {
    trigger: 'webhook',
    eventText: JSON.stringify(body ?? {}).slice(0, 4000),
  });
  return sendJson(response, 202, { queued: true, recipe: recipe.name });
}

// --- phase 4 helpers ---------------------------------------------------------------

/** Data-only text that starts a recipe — never instructions. */
function orderEventText(order, status) {
  const items = (order.items || []).map((item) => `${item.quantity} x ${item.name}`).join(', ');
  return `Event: order event\nOrder ${order.id.slice(0, 8)} — status: ${status}, total: ${order.total} USD, `
    + `customer: ${order.customer || 'unknown'}, items: ${items || 'none'}, note: ${order.note || '-'}`;
}

/** Milestone moments, counted in code, written to activity the instant they're real. */
function noteMilestones(userId, before) {
  const after = streaks.lifetimeRevenue(userId);
  for (const milestone of streaks.newMilestones(before, after)) {
    orderslib.addEvent(userId, {
      kind: 'milestone',
      title: milestone.note,
      detail: streaks.milestoneNote(milestone),
      amount: null,
    });
  }
}

// --- auth routes ----------------------------------------------------------------

async function registerUser(request, response) {
  const ipKey = `register:${request.socket.remoteAddress || 'unknown'}`;
  if (!loginLimiter.allow(ipKey)) {
    return sendJson(response, 429, {
      error: 'Too many account attempts. Try again in a few minutes.',
      code: 'rate_limited',
    });
  }
  const body = await readJson(request);
  const name = String(body.name || '').trim().replace(/[<>]/g, '').slice(0, 60);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (name.length < 2 || !auth.EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, 'Enter a valid name and email address.', 'invalid_input');
  }
  if (password.length < auth.PASSWORD_MIN || password.length > auth.PASSWORD_MAX) {
    throw new HttpError(400, `Use a password between ${auth.PASSWORD_MIN} and ${auth.PASSWORD_MAX} characters.`, 'invalid_input');
  }
  const user = await auth.createUser({ name, email, password });
  auth.mergeDeviceData(request, user.id);
  const token = auth.createSession(user.id);
  appendCookie(response, sessionCookie(appBaseUrl, token));
  appendCookie(response, deviceCookie(appBaseUrl, user.id, true));
  return sendJson(response, 201, { user: auth.publicUser(user) });
}

async function loginUser(request, response) {
  const ipKey = `login:${request.socket.remoteAddress || 'unknown'}`;
  if (!loginLimiter.allow(ipKey)) {
    return sendJson(response, 429, {
      error: 'Too many account attempts. Try again in a few minutes.',
      code: 'rate_limited',
    });
  }
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = await auth.verifyCredentials(email, password);
  if (!user) throw new HttpError(401, 'Email or password is incorrect.', 'bad_credentials');
  auth.mergeDeviceData(request, user.id);
  const token = auth.createSession(user.id);
  appendCookie(response, sessionCookie(appBaseUrl, token));
  appendCookie(response, deviceCookie(appBaseUrl, user.id, true));
  return sendJson(response, 200, { user: auth.publicUser(user) });
}

// --- order routes ----------------------------------------------------------------

/**
 * Customer message -> editable draft. With `preview: true` the sample is
 * parsed but not stored (the landing page loads it on every visit).
 */
async function parseOrder(request, response) {
  const body = await readJson(request);
  const description = String(body.description || '').trim();
  if (description.length < 8 || description.length > 1200) {
    throw new HttpError(400, 'Describe the order in 8 to 1,200 characters.', 'invalid_input');
  }

  // The landing page's sample is parsed but never stored; identify the owner
  // first for real requests so the per-account budget covers the AI call.
  const user = body.preview === true ? null : attachIdentity(request, response);

  const extracted = await extract(description);
  const { order, customer, source, provider, model } = extracted;

  if (!user) return sendJson(response, 200, { ...order, customer, mode: source, provider, preview: true });

  const draft = orderslib.createDraft(user.id, order, source, customer);
  return sendJson(response, 200, { ...order, customer, mode: source, provider, model, id: draft.id, status: draft.status });
}

/** Preview mode answers without credentials; Sandbox mode persists first. */
async function createCheckout(request, response) {
  const body = await readJson(request);
  const order = orderslib.validateOrder(body);

  if (!hasPaypal) {
    const user = attachIdentity(request, response);
    orderslib.addEvent(user.id, {
      kind: 'preview',
      title: 'Checkout preview opened',
      detail: 'Preview only · no payment was made',
      amount: order.total,
    });
    return sendJson(response, 200, {
      mode: 'preview',
      message: 'Add PayPal Sandbox credentials in .env to create a sandbox checkout.',
      order,
    });
  }

  const user = attachIdentity(request, response);
  const draft = orderslib.createDraft(user.id, order, 'checkout', body.customer || null);
  const checkout = await paypal.createPaypalOrder({ ...order, createRequestId: randomUUID() });
  const updated = orderslib.transition(draft, 'awaiting_buyer', {
    paypalOrderId: checkout.orderId,
    captureRequestId: randomUUID(),
    expiresAt: Date.now() + 3 * 60 * 60 * 1000,
  });
  orderslib.addEvent(user.id, {
    kind: 'checkout',
    title: 'Sandbox checkout created',
    detail: `Awaiting buyer approval · order ${updated.id.slice(0, 8)}`,
    amount: null,
  });
  return sendJson(response, 200, {
    mode: 'sandbox',
    orderId: checkout.orderId,
    approvalUrl: checkout.approvalUrl,
    status: updated.status,
    localOrderId: updated.id,
  });
}

// --- PayPal return + webhook -------------------------------------------------------

async function handlePaypalReturn(request, response, url) {
  if (url.pathname === '/paypal/cancel') return redirect(response, '/?payment=cancelled');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed.', 'method');
  }

  const paypalOrderId = url.searchParams.get('token') || '';
  if (!hasPaypal || !/^[A-Z0-9-]{5,80}$/i.test(paypalOrderId)) {
    return redirect(response, '/?payment=unavailable');
  }
  const order = orderslib.findOrderByPaypalId(paypalOrderId);
  if (!order) return redirect(response, '/?payment=unavailable');
  if (order.status === 'captured') return redirect(response, `/?payment=COMPLETED&order=${encodeURIComponent(paypalOrderId)}`);
  if (order.status !== 'awaiting_buyer') return redirect(response, '/?payment=error');

  try {
    const result = await captureOnce(order);
    if (result.status !== 'COMPLETED') return redirect(response, '/?payment=error');
    return redirect(response, `/?payment=COMPLETED&order=${encodeURIComponent(paypalOrderId)}`);
  } catch {
    return redirect(response, `/?payment=error&order=${encodeURIComponent(paypalOrderId)}`);
  }
}

/** Concurrent capture attempts (return redirect + webhook) share one call. */
const capturing = new Map();

function captureOnce(order) {
  if (capturing.has(order.id)) return capturing.get(order.id);
  const run = (async () => {
    const result = await paypal.capturePaypalOrder(order.paypalOrderId, order.captureRequestId);
    if (result.status === 'COMPLETED') markPaid(order, 'PayPal Sandbox payment completed');
    else if (result.status === 'FAILED' || result.status === 'DENIED') markFailed(order, 'Sandbox capture did not succeed');
    return result;
  })().finally(() => capturing.delete(order.id));
  capturing.set(order.id, run);
  return run;
}

/** Moves an order to `captured`, tolerating a webhook that got there first. */
function markPaid(order, title) {
  const before = streaks.lifetimeRevenue(order.userId);
  try {
    orderslib.transition(order, 'captured');
  } catch (error) {
    if (error instanceof HttpError && (error.code === 'stale_status' || error.code === 'illegal_transition')) return;
    throw error;
  }
  orderslib.addEvent(order.userId, {
    kind: 'capture',
    title,
    detail: `Buyer approval and capture succeeded · ${order.paypalOrderId}`,
    amount: order.total,
  });
  noteMilestones(order.userId, before);
  recipes.onOrderEvent(order.userId, 'order.captured', orderEventText(order, 'captured'));
}

function markFailed(order, title) {
  try {
    orderslib.transition(order, 'failed');
  } catch (error) {
    if (error instanceof HttpError && (error.code === 'stale_status' || error.code === 'illegal_transition')) return;
    throw error;
  }
  orderslib.addEvent(order.userId, {
    kind: 'capture',
    title,
    detail: `Sandbox order ${order.paypalOrderId}`,
    amount: null,
  });
  recipes.onOrderEvent(order.userId, 'order.failed', orderEventText(order, 'failed'));
}

/**
 * PayPal notifies us here. The signature is verified with PayPal before the
 * event is believed; handling is idempotent, so duplicate deliveries are 200s.
 */
async function handleWebhook(request, response) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'method');
  if (!paypal.webhookConfigured()) {
    throw new HttpError(503, 'Webhooks are not configured. Set PAYPAL_WEBHOOK_ID in .env.', 'webhook_unconfigured');
  }
  const event = await readJson(request, 64_000);
  const verified = await paypal.verifyWebhookSignature({ headers: request.headers, event });
  if (!verified) throw new HttpError(403, 'Webhook signature verification failed.', 'webhook_unverified');

  const { paypalOrderId, status } = paypal.orderTransitionFromEvent(event?.event_type, event?.resource);
  if (!status || !paypalOrderId) return sendJson(response, 200, { received: true, ignored: true });

  const order = orderslib.findOrderByPaypalId(paypalOrderId);
  if (!order) return sendJson(response, 200, { received: true, ignored: true });
  if (order.status === status) return sendJson(response, 200, { received: true, idempotent: true });

  try {
    const before = streaks.lifetimeRevenue(order.userId);
    orderslib.transition(order, status);
    orderslib.addEvent(order.userId, {
      kind: 'webhook',
      title: status === 'captured' ? 'PayPal webhook: payment captured' : 'PayPal webhook: payment failed',
      detail: `${event.event_type} · ${paypalOrderId}`,
      amount: status === 'captured' ? order.total : null,
    });
    if (status === 'captured') noteMilestones(order.userId, before);
    recipes.onOrderEvent(order.userId,
      status === 'captured' ? 'order.captured' : 'order.failed',
      orderEventText(order, status));
  } catch (error) {
    // A twin delivery that lost the race is not an error; anything else is.
    if (!(error instanceof HttpError) || (error.code !== 'stale_status' && error.code !== 'illegal_transition')) throw error;
  }
  return sendJson(response, 200, { received: true });
}

// --- static files ------------------------------------------------------------------

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed.', 'method');
  }
  try {
    const assetPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const safePath = normalize(assetPath).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
    const filePath = join(publicRoot, safePath);
    if (!filePath.startsWith(publicRoot)) throw new HttpError(403, 'Forbidden.', 'forbidden');
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new HttpError(404, 'Not found.', 'not_found');
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Content-Length': content.length,
    });
    return response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'Not found.', 'not_found');
  }
}

// --- config ----------------------------------------------------------------------

function loadEnv(path) {
  return readFile(path, 'utf8').then((contents) => {
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }).catch(() => {});
}
