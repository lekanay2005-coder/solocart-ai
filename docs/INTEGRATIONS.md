# Integrations and automations (phase 4)

What the Butler port adds: MCP connections, recipes with an approval gate, a
SQLite job queue, AI-free summaries, and Byte's state machine. This file says
what actually works, how to switch it on, and where the limits are.

## The rule everything follows

**Read-only steps run on their own. Anything that sends, changes or deletes is
the last step and waits for a human's yes.** This is enforced in three places,
not just promised:

- tool descriptors carry `readOnly`, and write tools default to `ask` —
  `setRule()` clamps `auto` away from writes server-side, so the UI cannot
  promote one;
- the recipe loop parks a write step as a `recipe_runs` row with
  `status = 'waiting'` and the tool + args stored — until
  `POST /api/recipes/approvals/:id` is called with `confirm: true`, the tool
  never executes;
- Ask Byte keeps its existing token confirm (phase 2), unchanged.

Declining closes the run and writes nothing. The run's `say` always records
what happened, so Runs history can explain itself.

## Recipes

Instructions the seller writes once, executed by the AI-provider chain.

| Trigger | Config | Notes |
| --- | --- | --- |
| `manual` | — | "Run now" button or `POST /api/recipes/:id/run` |
| `schedule` | `run_at` (HH:MM) + `run_days` | Seller's time zone (`APP_TZ`). Runs once per day, inside a 3-hour window after the time (missed-by-more windows are skipped, like Butler). |
| `order_event` | `event`: `order.captured`, `order.failed`, `order.settled` | Fired by real server transitions (capture, PayPal webhook, offline redemption). The event text is data only — the prompt tells the model to treat it as such. |
| `webhook` | — | A 48-hex secret link, `POST {APP_BASE_URL}/hooks/<token>`. Stored as a SHA-256 hash; the plaintext exists only once, at creation. Rate-limited 30 s apart, 30 per day per recipe, and per IP. |

Every run goes through the **job queue** (`server/integrations/jobs.mjs`):
enqueue → sweeper (every 60 s, plus an immediate tick after a manual run or
webhook) → claim → execute. Failures retry 3 times with 30 s, 60 s, 120 s
backoff, then sit in `failed` with the error. A schedule claim writes
`scheduled_on`, so two overlapping sweeps cannot double-run a recipe.

**Recipes need an AI provider.** The planning step is the one place a model is
load-bearing — with no key configured, the run fails immediately with:

> Recipes plan their steps with an AI provider — add OPENAI_API_KEY (or another key) in .env to run recipes.

That message lands in Runs history (`status: failed`) and in the job's
`last_error`. Nothing is simulated. Set any key from `.env` and recipes run for
real. Unit tests inject a fake planner to prove the mechanics without keys.

### Built-in tools

Every recipe can use these (plus MCP tools below):

| Tool | Reads/writes | What it does |
| --- | --- | --- |
| `orders/list` | reads | Orders as JSON, optional status filter |
| `orders/totals` | reads | Revenue/awaiting/expenses from `totals()` — counted in code |
| `activity/recent` | reads | The desk's server-written event feed |
| `brief/morning` | reads | The AI-free morning brief |
| `recap/week` | reads | The AI-free weekly recap |
| `reminders/list` | reads | Reminders still due |
| `reminders/add` | **writes** | Creates a reminder (always asks) |
| `hooks/post` | **writes** | POSTs a JSON body to a public https webhook URL (always asks) |

`hooks/post` is the "add a row to my Notion/Sheet" path without any MCP server:
Notion incoming webhooks and Google Apps Script web apps accept a JSON POST and
authenticate by URL. It takes **no custom headers** — a header-carrying auth
belongs in an MCP connection, where the key is vaulted. The URL still goes
through the SSRF guard on every call.

## MCP connections

Add a server by link + key. The key is encrypted with AES-GCM (`APP_VAULT_KEY`)
before it touches SQLite and never appears in any API response. `discover()`
lists its tools; `readOnlyHint` annotations set the default rule; per-tool
rules are `auto` / `ask` / `off` (writes can only be `ask` or `off`).

**Without `APP_VAULT_KEY`, connections and secret links are refused** with a
clear 503 — no plaintext fallback, ever. Changing the key later makes every
stored secret unreadable by design (the connection must be re-entered).

**SSRF guard** (`outbound.mjs`, port of Butler's): https only, no credentials
in the URL, DNS resolved and checked against loopback / RFC1918 / link-local /
carrier-grade NAT / multicast / this server's own address, redirects re-checked
per hop, cross-origin redirects refused so a vaulted key never leaks to another
host. Like Butler's, it can be raced by a DNS name that repoints between check
and call — that limit is stated in the file header too.

The guard therefore **blocks `http://localhost` MCP servers in production** —
by design. Tests swap in a plain fetch (`mcp.useFetch`) to reach a local fake
MCP server, exactly as Butler's tests do.

The MCP client is hand-written (Streamable HTTP JSON-RPC: `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`, JSON **and** SSE
responses, session header, `DELETE` on close, one protocol-version retry)
because the brief caps runtime dependencies at the noble pair plus a QR lib.

## Summaries (no AI needed)

`/api/report` returns, all computed in SQL and code:

- **Morning brief** — orders awaiting payment, money captured *yesterday* in
  the seller's time zone, offline confirmations waiting to be redeemed, drafts,
  reminders due today, current sale streak.
- **Weekly recap** — last 7 local days: captured total, orders by state, best
  day, top three orders.
- **Streaks & milestones** — days in a row with a sale (Butler's algorithm:
  this morning doesn't break yesterday's streak), lifetime revenue/count,
  reached thresholds ($100 / $500 / $1,000 / $2,500 / $5,000 / $10,000 and
  1 / 10 / 25 / 50 / 100 / 250 paid orders). When a capture or redemption
  *crosses* a threshold, a `milestone` activity event is written at that
  moment.

The Overview page shows it under **Desk report**, tagged `AI-FREE · COMPUTED
IN CODE`.

## Byte's state machine

`public/byte.js` + CSS poses on the existing inline SVG (no new art files, no
layout change). States and durations follow Butler's little-butler behavior
spec: `idle` (breathing, random blinks) → `blink`, `think` while the AI runs,
`work` while a job runs, `success` on captures/approvals, `error` on failures,
`attention` while a confirm is pending, `listen` during voice input, `speak`
when replying, `sleep` after 60 s of quiet, `peek`/`hide`, and `drag` (pointer
past the 7 px threshold; release docks back).

- Optional: **Settings → Byte's reactions** (device-local, like the theme).
- `prefers-reduced-motion`: no breathing loop, no blink loop, no sway or bob —
  poses change instantly, which the behavior spec allows.

## Endpoints

```
GET    /api/report                    brief + recap + streak + milestones
GET    /api/recipes                   recipes, pending approvals, runs, jobs, tools
POST   /api/recipes                   create (validates name/words/schedule/event)
DELETE /api/recipes/:id
POST   /api/recipes/:id/run           queue a manual run (202)
POST   /api/recipes/:id/hook          mint the secret link (returns it once)
DELETE /api/recipes/:id/hook          drop the link
GET    /api/recipes/runs              runs + pending + jobs
POST   /api/recipes/approvals/:id     {confirm: true|false} — the only write path
GET    /api/integrations              connections (locked secrets), call log, vault status
POST   /api/integrations              add a connection (503 without APP_VAULT_KEY)
POST   /api/integrations/:id/refresh  re-discover tools
POST   /api/integrations/:id/rules    {tool, rule}
DELETE /api/integrations/:id
POST   /hooks/:token                  external trigger (outside same-origin; token is the check)
```

## Setup

```bash
cp .env.example .env
# .env:
APP_VAULT_KEY=<any long random string>   # required for connections + secret links
OPENAI_API_KEY=...                        # any one provider; required for recipes to plan
APP_TZ=UTC                                # schedule + "yesterday" time zone
npm start
```

## What is not built

- No Notion/Google first-party OAuth — webhooks and MCP cover both honestly.
- No recipe-level tool allow-list (Butler had per-recipe `connections`); all of
  a seller's non-disabled tools are visible to every recipe.
- The email trigger (Butler's Gmail watcher) is not ported: SoloCart has no
  mail integration to watch.
- The approval step runs the parked write and finishes the run; there is no
  post-approval re-plan loop (the write is always the last step by rule).
- MCP `use` calls are logged in `mcp_calls` with `asked` recorded; there is no
  UI page for the log yet (`GET /api/integrations/calls` serves it).
