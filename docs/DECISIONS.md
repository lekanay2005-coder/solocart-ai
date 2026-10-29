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
