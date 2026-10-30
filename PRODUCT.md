# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (seller desk) + mobile (buyer app, Expo Go)

## Stack

One dependency-light Node.js server (built-in `node:sqlite`, `@noble/curves`
and `@noble/hashes` as its only runtime dependencies) serving a vanilla
HTML/CSS/JavaScript desk, plus an Expo/React Native buyer app in
`apps/morrow-mobile/`. Plain `.mjs` with JSDoc on the server; TypeScript in the
mobile app. This keeps the solo hackathon prototype easy to run and inspect.

## Users

Working assumption: independent sellers who receive order requests in natural
language and want a fast way to prepare checkout without hand-building a cart,
and their buyers, who pay from a phone link — online through PayPal Sandbox or
offline through a signed handoff when connectivity is gone.

## Product Purpose

Working assumption: SoloCart turns a customer's plain-language request into an
editable order draft, then hands the buyer off to PayPal Sandbox for approval.
Success means a seller can verify the line items and total before the buyer
sees checkout — and that a payment made without connectivity still lands in
the seller's ledger with a verifiable signature, never a leap of faith.

## Positioning

Working assumption: the seller remains the review point between AI extraction
and payment. The AI prepares order details and plans automations; it cannot
approve or capture a payment on its own — every write action waits for a
human's confirm click.

## Operating Context

This is a solo PayPal AI Hackathon prototype. The submission needs a working
demo, a public source repository with a license, setup instructions, and a
short video. The hackathon requires meaningful use of both PayPal and an AI
tool.

## Capabilities and Constraints

- The desk supports an editable USD order draft and delivery fee.
- AI extraction is optional and configured server-side (OpenAI first, with a
  Gemini/OpenRouter/Groq fallback chain); a local parser is a labeled,
  credential-free preview.
- PayPal Orders v2 is configured for Sandbox only; the server never uses
  PayPal Live endpoints.
- Offline payments: signed requests and confirmations (Ed25519), a redemption
  ledger with double-spend protection, byte-identical wire formats across
  server, browser and app. Settlement is simulated — no money moves offline.
- Automations: AI-planned recipes with an approval gate before writes, MCP
  connections, SSRF-guarded outbound webhooks, an encrypted secrets vault,
  AI-free summaries — all persisted in local SQLite with a retrying job queue.
- Accounts are local (salted scrypt hashes, HttpOnly sessions, same-origin
  checks) and everything lives in one `data/solocart.db` file; there is no
  managed database, verified email, account recovery, or production payment
  support.
- The mobile app ships with BMONI behind a flag that is **off by default**
  (its KYC path is blocked); SoloCart's own server replaces it.
- The target deploy platform and hosting provider are undecided.

## Evidence on Hand

The project is presented as a PayPal AI Hackathon prototype: AI-assisted order
extraction leads to seller review, followed by PayPal Orders v2 Sandbox buyer
approval and capture, with a signed offline handoff into the same ledger and
automations gated behind human confirmation. The local parser, checkout
preview, multi-rail routes, security panel and offline settlement are
explicitly labeled as fallbacks or simulations; they are not represented as
live integrations. 114 server tests plus the mobile suite assert the wire
formats stay byte-identical.
