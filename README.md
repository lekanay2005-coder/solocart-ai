# SoloCart

**From customer message to confident checkout.** SoloCart is an AI checkout
workspace for solo sellers: the seller's desk runs in a browser, buyers can pay
from a phone (the Expo app in `apps/morrow-mobile/`), and both are backed by
one dependency-light Node server. A seller describes the request, reviews the
extracted items and prices, and hands the buyer off to a PayPal **Sandbox**
approval page — with an offline signed-handoff flow, automations with an
approval gate, and Byte the pet companion alongside.

## What's in the box

- **The desk** (`public/`, one vanilla HTML/CSS/JS client): order workspace,
  orders, activity, payment routes, security panel, offline pay, automations,
  Byte's corner, account/settings — eleven views, light/night theme, private
  amounts.
- **The AI**: OpenAI's Responses API (and a Gemini/OpenRouter/Groq fallback
  chain) turns a customer message into an editable draft. Without any key a
  local parser keeps the demo usable and the header says which mode is live.
  Ask Byte turns a typed command into one plan — reads run immediately, writes
  wait for your confirm click. Provider memory and rules live on the server.
- **Payments**: PayPal Orders v2 in **Sandbox only** (the API host is
  hard-wired; live credentials cannot be used). The seller reviews every line
  before PayPal ever sees the order.
- **Offline payments**: a signed payment request leaves the desk as a link or
  QR, the buyer signs the confirmation on their phone, and the desk redeems it
  in a ledger with double-spend protection. The wire format is byte-identical
  between server, browser and app — one shared fixture
  (`tests/fixtures/offline-vectors.json`) is verified by all three.
- **Automations**: recipes (scheduled or event-triggered) plan their steps with
  an AI provider, run reads freely, and pause at a confirmation gate before any
  write. MCP connections, outbound webhooks with an SSRF guard, an encrypted
  secrets vault, and an AI-free morning brief / weekly recap round it out.
- **The mobile app** (`apps/morrow-mobile/`): the Morrow wallet as SoloCart's
  buyer app — QR/link scanning, a Reserve for offline spending power, and a
  paste fallback for anything a camera misses. Point it at your desk with
  `EXPO_PUBLIC_SOLOCART_URL`, or leave it unset for device-to-device mode with
  zero setup in Expo Go.

## What works, what is simulated

Be honest with your audience before demoing:

| Piece | Status |
| --- | --- |
| Order extraction | Real when a provider key is set; otherwise the local parser, labeled as a fallback. |
| PayPal checkout | Real PayPal **Sandbox** API calls — fake money, real approval and capture. Live payments are impossible by design. |
| Offline signing / redemption | Real Ed25519 signatures, a real ledger, real double-spend rejection. **No money moves offline**: settlement is simulated, as the UI's `SIMULATED SETTLEMENT` tag says. |
| Multi-rail payment routes | Interface simulation (PayPal Sandbox is the only connected rail). |
| Security panel | Demo-only illustrative status. |
| Automations / MCP | Real local execution and real MCP HTTP calls; recipes that need planning show an explicit "add OPENAI_API_KEY" failure instead of pretending. |
| BMONI rail in the app | **Off by default** (`EXPO_PUBLIC_BMONI_MODE=live` enables it); its KYC path is blocked upstream, so the default install never touches it. |
| Milestones and activity | Server-computed from real ledger data, written as events — not invented by the model. |

## Requirements

- **Node.js 22.5 or newer** (the server uses the built-in `node:sqlite`)
- Optional: an AI provider key (`OPENAI_API_KEY` and/or Gemini/OpenRouter/Groq)
- Optional: PayPal Developer **Sandbox** credentials
- Optional (mobile): the Expo Go app on a phone

## Run the desk

```sh
cp .env.example .env
npm install
npm start
```

Open [http://localhost:4173](http://localhost:4173). The sample order is
already in the request box: press **Organize order**, review the draft, then
**View checkout preview**.

Run the test suite (114 tests, no network, no credentials):

```sh
npm test
```

Data (accounts, sessions, orders, activity, offline ledger, recipes, runs)
lives in `data/solocart.db` (SQLite, WAL). Delete that file to reset.

## Connect the AI (optional)

Set `OPENAI_API_KEY` in `.env` (see `.env.example` for the full fallback-chain
knobs: `AI_PROVIDER_ORDER`, model names per provider). The order text is sent
with instructions to treat it as untrusted input and return order details
only; SoloCart displays the result as a draft for seller review.

## Connect PayPal Sandbox (optional)

1. Create a Sandbox REST app in the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).
2. Put its Sandbox client ID and secret in `.env` as `PAYPAL_CLIENT_ID` /
   `PAYPAL_CLIENT_SECRET` (plus `PAYPAL_WEBHOOK_ID` for webhook verification).
3. Restart and check out with a Sandbox **personal** account as the buyer
   (the **business** account is the seller).

**Never use live credentials.** The server only ever talks to PayPal's
Sandbox host. Pending order IDs live in memory for three hours; a restart
clears them.

## Run the mobile app

```sh
cd apps/morrow-mobile
npm install
cp .env.example .env        # then set EXPO_PUBLIC_SOLOCART_URL
npx expo start              # scan the QR with Expo Go
```

`EXPO_PUBLIC_SOLOCART_URL` is the desk's origin, e.g.
`http://192.168.1.10:4173` (no path, no trailing slash). Unset — or `local` —
keeps the original device-to-device mode: no server contacted, the merchant
phone verifies confirmations peer-to-peer. The mobile checks are
`npm test` (vitest) and `npx tsc --noEmit` in the same directory.

## Offline payments in one minute

1. On the desk open **Offline pay**, pick a draft, **Issue payment request** —
   a signed request is created (60-minute TTL, configurable).
2. Hand the buyer the link/QR — that step needs no connectivity on their side.
3. The buyer's app (or `pay.html` in a browser) signs the confirmation with
   their Reserve or wallet; the server verifies it before anything is
   deducted, then the desk redeems it into the ledger.
4. Redemption settles it in SoloCart's book — the UI always says `pending`
   until then, never "settled" by assertion.

Details: [docs/OFFLINE_PAYMENTS.md](./docs/OFFLINE_PAYMENTS.md).

## Design

The web UI follows the
[SoloCart Stitch workspace](https://stitch.withgoogle.com/projects/2773758884601685044):
midnight navy canvas, amber order-preparation cues, PayPal blue reserved for
checkout. See [DESIGN.md](./DESIGN.md) for the visual rules — they are
unchanged by every phase in this repository.

## More documentation

- [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md) — recipes, approval gate, MCP, vault, webhooks
- [docs/OFFLINE_PAYMENTS.md](./docs/OFFLINE_PAYMENTS.md) — the signed handoff and the ledger
- [docs/AI.md](./docs/AI.md) — provider chain, Ask Byte, memory, rules
- [docs/DECISIONS.md](./docs/DECISIONS.md) — why each phase was built the way it was
- [DEMO-WALKTHROUGH.md](./DEMO-WALKTHROUGH.md) — the recording outline
- [PRODUCT.md](./PRODUCT.md) — product framing

## Example request

> 2 handwoven baskets at $18 each, delivery $5

Expected review: 2 × $18.00 items, $5.00 delivery, $41.00 total.

## Submission notes

- Product: SoloCart — desk, mobile buyer app, offline handoff, automations.
- AI: OpenAI Responses API with a Gemini/OpenRouter/Groq fallback chain; local
  parser only as a labeled fallback.
- Payment integration: PayPal Orders v2 REST in **Sandbox**, buyer approval
  and capture; offline redemption is a signed ledger, settlement simulated.
- Run: `cp .env.example .env && npm install && npm start`
- Tests: `npm test` (114 server tests) · `cd apps/morrow-mobile && npm test && npx tsc --noEmit`
- Licensing: MIT for original SoloCart code, **AGPL-3.0 for Butler-derived
  modules**, unlicensed Morrow-derived upstream — see [LICENSING.md](./LICENSING.md)
  and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## What this prototype is not

It is a hackathon prototype, not a production payment system: no live PayPal,
no verified email or account recovery, no MFA, no inventory. Offline
settlement moves no money. Sessions and orders are local SQLite, not a managed
database. Do not reuse an important password or expose this server publicly.
