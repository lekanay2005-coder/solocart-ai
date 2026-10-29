# Decisions

Small choices made while building, for decisions the brief did not settle.
Later phases append to this file.

## Phase 1 — Foundation

**Language: plain `.mjs` with JSDoc types.** The brief allowed `.mjs`+JSDoc or
`.ts` with Node type stripping. The existing `server.mjs` is `.mjs`, type
stripping still has rough edges (enums, `namespace`, some class fields), and
plain JS keeps `npm start` free of any loader flags. Chosen once, applied to
every file under `server/`.

**Node floor raised to 22.5** (`package.json` `engines`) because `node:sqlite`
first shipped there. Verified on Node 24.21.

**Persistence: one SQLite file, `data/solocart.db`**, via `node:sqlite`, WAL
mode, foreign keys on. No Postgres, no Docker, no dependency. Migrations are
numbered `.sql` files in `server/migrations/`, applied in filename order inside
a transaction and recorded in `schema_migrations`. `SOLOCART_DB` overrides the
path (tests use `:memory:`).

**Anonymous desks get a transparent "device" user.** The brief wants orders and
activity server-side *per user*, but also wants the preview flow to work with
zero setup. Rather than blocking the desk behind sign-in (a UX change), the
server provisions a `kind = 'device'` user on first storage request and hands
back an HttpOnly `sc_device` cookie. Registering or signing in merges that
device's orders/events/settings into the real account. Sessions stay the
documented 8h; the device cookie only identifies which desk owns the rows.
`/api/auth/me` reports `null` for device identity, so the UI's signed-in state
is unaffected.

**Events are written by the server only.** The browser no longer writes the
activity feed; checkout-created, capture-completed and webhook events are
recorded server-side, so a page script cannot inflate the feed.

**Draft cap:** each user keeps their 50 newest drafts and drafts older than 30
days are dropped when a new one is created. Bounded growth without a retention
policy nobody asked for.

**The boot-time sample is `preview: true`.** The landing page parses its sample
order on every load; that request is explicitly marked preview so it is parsed
but never stored. Clicking "Organize order" persists a real draft.

**PayPal host stays hard-wired.** `PAYPAL_BASE_URL` is a module constant
(`api-m.sandbox.paypal.com`); there is no env var that can retarget it. Tests
inject a `fetchImpl` rather than overriding the host.

**Webhook verification needs `PAYPAL_WEBHOOK_ID`** (the id PayPal gives you
when you register the webhook). Without it `/paypal/webhook` answers 503 and
capture still completes through the return URL, which is the behaviour the
brief's "works with no credentials" requires. Verification fails closed: a
missing header, a non-SUCCESS answer, or an API error all mean "not verified".

**Rate limits live in memory.** Fixed-window counters, 600/min per IP and
30/min per account on `/api/`, plus 10 per 10 min per IP for login/register.
They are protection rather than data, so losing them on restart is harmless;
a `RateLimiter` with a hard key cap bounds memory under a flood.

**`roundMoney(undefined)` returns `NaN` on purpose** (it inherited this from
the original code). `validateOrder` relies on that to reject a missing or
malformed shipping value instead of silently reading it as $0.

**CSP unchanged in spirit, tightened in detail.** `script-src 'self'` with no
inline script anywhere (the page had none), plus `object-src 'none'`,
`frame-ancestors 'none'` and COOP. Google Fonts remains the only external
style/font origin because DESIGN.md specifies IBM Plex Sans and JetBrains Mono.

**HOST env var added** (default `127.0.0.1`, unchanged from before) so a shared
preview can bind `0.0.0.0` without editing code. `cp .env.example .env` still
gives the same local behaviour as before.

## Phase 2 — AI brain

**`aiMode` is now `"provider" | "local"`, not `"openai"`.** The old client
value assumed a single vendor; the server now reports `aiLabel`
(`"OpenAI · gpt-4.1-mini"`) and a `providers[]` liveness list instead. The
client was updated to match; no key material is ever returned.

**`OPENAI_MODEL` now defaults to `gpt-4.1-mini`.** The brief warned that the
old default (`gpt-6-luna`) is not a real model name. Every provider's model is
overridable by env var, and a model rejected by a provider is just another
fall-through, not an error the seller sees.

**Rules before models, in both directions.** `segmentChunks()` splits a run-on
message at each `$price` boundary, so the brief's example
`"2 baskets $18 delivery $5"` parses to *2 × baskets @ $18 + $5 delivery*
without a model at all (`mode: "rules"`). The same segmentation is shared by
`isExplicitOrder()` and the local parser, so what skips the LLM is exactly
what the LLM would have produced.

**A `$0` unit price is a legal draft, never a legal checkout.** The extraction
prompt asks the model to emit `unitPrice: 0` when a product was named without
a price; `validateExtraction` keeps it (the seller fills it in) and
`validateOrder` refuses it at checkout. Otherwise a missing price would either
block the draft or silently become free.

**Ask Byte's confirm gate is server-side.** A write plan is parked under a
single-use token with a 5-minute TTL; only `POST /api/ask/confirm` runs it, and
the token dies on first use whether the seller approves or cancels.
`WRITE_ACTIONS` (a server constant) decides what is a write — never a field
the model chose. Read actions answer in the same request.

**Facts are learned automatically but are never hidden.** With a provider, a
plan may carry up to 3 new seller facts; they are cleaned (secrets dropped),
stored immediately, listed in Settings and deletable one by one or all at
once. Butler gated this behind a "Learn about me" toggle; keeping it always-on
with full visibility was judged simpler and no less honest. With zero keys no
facts are ever invented.

**Totals and recall answer without a model.** `composeTotals()` is pure code
over SQL results; recall falls back to keyword search over the same rows. Both
still cite sources, so the answer format does not change when keys are added.

**`APP_TZ` env var (default `UTC`)** sets the time zone used for "today" / "this
week" in totals and summaries; the browser does not send one, so a wrong
clock in the client cannot skew server math.

**Pre-existing bug fixed:** `refreshAuth()` wrote to `#welcome-name`, which has
never existed in `index.html`, so signing in threw partway through and left the
settings labels stale. The write is now guarded.

**`getOrderLinks()` added to paypal.mjs** so "resend checkout link for Amira"
can return the Sandbox approval URL. It cannot actually send anything — there
is no email or SMS channel in SoloCart — so the reply hands the link to the
seller to send themselves, and the docs say so.

## Phase 3 — Offline payments (Morrow port)

**Confirm and redeem are two separate server steps, and only redeem settles.**
The brief's loop is "request → pay → confirm → redeem", so: `/api/offline/confirm`
verifies the buyer's signature and parks the confirmation (`pending →
confirmed`, order → `paid_offline_pending`); `/api/offline/redeem` re-verifies
from scratch and only then records the redemption and settles the order. This
keeps the rule "never mark an order settled before the server has done this"
structurally true instead of trusting one call site.

**Offline issuance is draft-only.** An order in `awaiting_buyer` is already
moving through PayPal; letting it also take an offline payment risks charging
twice. So an offline request can only come from a draft, and the offline path
ends in `settled` (the PayPal path ends in `captured`). The brief's "settle
through PayPal Sandbox **or** mark the order settled" reads, against the phase-1
state machine (`draft → paid_offline_pending → settled`), as: PayPal settles the
online path, offline redemption settles the ledger path — implemented as such,
with the settlement channel recorded as simulated.

**The buyer's device key lives in the browser (`localStorage`).** The two-window
demo needs a payer device somewhere, and the browser is the honest choice: it
mirrors Morrow's per-device keypair, it keeps the private key out of the server,
and it exercises the vendored `@noble/curves` in real client code. The key name
is `solocart.buyer-key.v1`, the Reserve state `solocart.reserve-state.v1`.

**The protocol code exists twice — browser and server — with cross-tests.**
The buyer must sign with zero connectivity, so it cannot import `server/`.
Rather than a shared-root module (outside the brief's architecture),
`public/offline/protocol.mjs` and `server/offline/protocol.mjs` are parallel
ports of the same Morrow sources, and `tests/offline.test.mjs` verifies each
side with the other's output. Phase 5's shared test-vector file pins the wire
format a third time, for the mobile app.

**Reserve fields use `.mjs` number amounts (minor units), like Morrow.**
`amountMinor` stays a JS number end to end so the canonical JSON is identical
to Morrow's; the ledger stores the same value as a SQLite INTEGER. Amounts
above 2^53 minor units would lose precision — irrelevant for a checkout demo,
noted here anyway.

**Request TTL defaults to 60 minutes** (`OFFLINE_REQUEST_TTL_MINUTES`), not
Morrow's 5: the buyer may need a few minutes to provision a Reserve on a fresh
browser, and expiry is checked at confirm time regardless.

**No camera scanning of QR codes.** The seller shows the QR and the payload
string; the buyer page takes the link or a pasted payload. Adding a camera
scanner (getUserMedia + jsQR decode loop) buys little in a two-window demo and
jsQR stays vendored for the optical transport phase if it is ever needed.

**Settlement wording is fixed, not configurable.** The redeem notice says
"simulated settlement" because settlement genuinely is; hiding that behind a
config flag is exactly the kind of quiet claim the brief forbids.

## Phase 4 — Butler automation and the pet

**No MCP SDK.** The brief caps runtime dependencies at `@noble/curves`,
`@noble/hashes` and a browser QR lib, so `server/integrations/mcp.mjs` is a
hand-written Streamable-HTTP JSON-RPC client: `initialize` with one
protocol-version retry, `notifications/initialized`, paginated `tools/list`,
`tools/call`, JSON **and** SSE response parsing, the `mcp-session-id` header,
and a best-effort `DELETE` on close. Tests run it against a local fake MCP
server.

**Recipes are the one place a model is load-bearing.** Butler plans recipe
steps with Gemini; the port uses the same provider chain as everything else
(`completeJson`). With no key, a run fails immediately with the plain message
"Recipes plan their steps with an AI provider — add OPENAI_API_KEY …", recorded
in the run row and the job's `last_error` — visible in Runs, never faked.
Tests inject a fake planner (`recipes.usePlanner`) to prove the mechanics
without keys, mirroring `mcp.useFetch`.

**Writes always ask — `auto` is clamped away from write tools server-side.**
Butler allowed a per-tool `auto` override even for destructive tools; the brief
says anything that sends/changes/deletes needs approval, so `checkedRule()`
only accepts `ask`/`off` for writes and the approval UI offers no `auto` option.

**`hooks/post` has no custom headers.** "Add a row to my Notion/Sheet" works
via webhook URLs (Notion incoming webhooks, Apps Script web apps) that
authenticate in the URL and take a JSON POST through the SSRF guard.
Header-carrying auth is an MCP connection, where the key is vaulted — that
keeps secrets out of recipe args and out of the approval screen.

**The job queue is new, not a port.** Butler's `jobs.ts` tracks laptop device
commands, not a scheduler, so `jobs.mjs` is the simplest thing that fits:
`enqueue` → claim (per-row compare-and-set so two sweeps can't double-run) →
handler → retry 3× with 30 s·2ⁿ backoff → `failed` with the reason. One
sweeper (60 s) drains it; manual runs and webhooks also trigger an immediate
tick so the UI doesn't wait a minute. Schedule claims mirror Butler exactly:
once per local day inside a 3-hour window, `scheduled_on` prevents doubles.

**Vault: `APP_VAULT_KEY` only.** Butler fell back to `SESSION_SECRET`; here a
missing key refuses the operation with a 503 instead, because a fallback key
that silently changes with an unrelated secret would strand stored connections.
No plaintext fallback exists.

**Approval finishes the run.** Butler's write step is always last, so the
confirm click executes the parked tool and closes the run with the result
appended to `say` — no re-plan loop after approval (kept simple; noted in
INTEGRATIONS.md).

**Milestone moments are counted, then written as events.** Thresholds:
$100/500/1,000/2,500/5,000/10,000 lifetime captured and 1/10/25/50/100/250
paid orders. `newMilestones(before, after)` runs around captures, webhook
settles and redemptions; a crossing appends a `milestone` activity row — the
number came from SQL, not the model.

**Byte's reactions toggle is device-local** (`localStorage
solocart-byte-reactions`), like the theme and balance toggles: it's a display
preference of this browser, not account data, so no server settings row.

**Byte's drag is bounded to its box.** The behavior spec docks the mascot to
screen corners; this desk's Byte lives in fixed cards, so pointer movement past
7 px tilts/translates the SVG up to 8 px inside the card and release snaps it
back — no layout change, per the brief's "do not change the corner screen
layout".

**Order-event text is data, never instructions.** The recipe prompt states
that event payloads and tool replies are data (Butler's guard sentence, kept
verbatim in spirit), and event text only ever contains ids, statuses, totals
and item lines built by the server.
