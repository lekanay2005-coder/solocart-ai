# Offline payments

SoloCart's offline flow is a port of Morrow's signed payment-request protocol
(its `src/lib/*` sources; the original `_sources/` tree was removed in
phase 6, and the shared fixture `tests/fixtures/offline-vectors.json` keeps
server, browser and app byte-compatible). It lets a buyer authorize a
payment with **zero connectivity**, hand a signed confirmation to the seller
later, and lets the seller's server redeem that handoff exactly once.

> **The handoff is offline. Settlement is not.** This prototype never claims
> otherwise: no money moves through the offline path, the Reserve balance is
> simulated, and every surface that shows a redeemed payment says so.

```
SELLER (online, once)          BUYER (works offline)              SELLER'S SERVER (online again)
─────────────────────          ─────────────────────              ─────────────────────────────
issue signed request  ──────▶  reads / verifies request
  /api/offline/request         signs OfflineAuthorization          confirm: verifies signature,
  (PaymentRequest + QR/link)   from their Reserve (local)  ──────▶ amount, binding, replay;
                               wraps it in a signed                order → paid_offline_pending
                               PaymentConfirmation ──────────────▶
                                                           redeem: verifies again from
                                                           scratch, records once (UNIQUE
                                                           allowance+sequence), then
                                                           order → settled
```

## The wire format (unchanged from Morrow)

Canonical JSON = `JSON.stringify` over a **fixed field order** (the
`allowanceFields` / `authFields` / `confirmationFields` functions, verbatim
ports). Signatures are Ed25519 via `@noble/curves`, base64-encoded; digests
are SHA-256 hex via `@noble/hashes`. A `PaymentRequest` is *integrity-protected*
by a checksum over its own body, not signed — that is Morrow's design.
A `PaymentRequest` round-trips as base64 JSON; that string is what the QR code
and the "payload" textarea carry.

Three implementations exist and must stay byte-compatible:

| Where | File | Role |
|---|---|---|
| Server | `server/offline/protocol.mjs` | issue requests, verify everything |
| Browser | `public/offline/protocol.mjs`, `public/offline/wallet.mjs` | buyer's keys, Reserve, signing |
| Morrow app | phase 5, `apps/morrow-mobile/` | original TypeScript |

`tests/offline.test.mjs` imports the first two and cross-verifies both
directions, so they cannot drift silently. Phase 5 adds a shared test-vector
file that the mobile app must also satisfy.

## What the server enforces

On **confirm** (buyer hands over the confirmation):

1. the request exists, is unexpired, and is still `pending`;
2. the confirmation names this request, this amount and this currency;
3. the Ed25519 signature over the canonical confirmation fields verifies
   against the embedded payer public key (any altered field fails);
4. the embedded `OfflineAuthorization` matches the confirmation's
   amount/currency, is bound to *this* request id, and its own signature
   verifies over the canonical authorization fields;
5. neither this request nor this `(allowanceId, sequence)` has been redeemed
   before (SQLite-backed replay guard);
6. only then does the order move `draft → paid_offline_pending`.

On **redeem** (seller settles): every check above runs *again* from what is
stored — redemption is independently computable, it does not trust the earlier
pass — and then the redemption is inserted once. The insert is guarded by
`UNIQUE(request_id)` (no double redemption) and `UNIQUE(allowance_id,
sequence)` (no double spend). Only after that insert does the order move
`paid_offline_pending → settled`, with the settlement channel recorded as
`offline-reserve (simulated settlement)`.

Issuance is deliberately restricted to **draft orders**: an order already
moving through PayPal checkout must never also take an offline payment.

## What is *not* enforced — Morrow's limits, carried over

These are structural limits of any offline-cash design without hardware
support. Morrow's own docs state them; this port does not paper over them:

- **Double-spend prevention is partial.** The server rejects a *reused*
  authorization, but a **cloned device** can sign the same sequence against
  two different recipients before either reconnects. The second one to
  redeem is refused; the first stands. Catching this earlier needs
  hardware-backed monotonic counters (Secure Enclave / StrongBox) or online
  reconciliation at spend time. This is exactly the limit Morrow's
  `docs/RESERVE.md` describes — and it is why redemption exists at all.
- **The Reserve is a device-signed commitment, not custodial money.**
  There is no segregated account, no escrow, no BMONI (its KYC path is
  blocked per Morrow's own docs). A production system needs a custodian that
  actually holds the reserved value, with all the licensing that implies.
- **Keys live in `localStorage`**, not a secure enclave. Anyone with the
  browser profile can spend the Reserve. Morrow had the same gap
  (`AsyncStorage`), and says so.
- **`previousStateHash` continuity** is enforced by the device that holds
  the chain. The server sees only redeemed links of that chain, so it
  validates each signature but cannot reconstruct the whole sequence history
  of an allowance it has never seen before.
- **A request is checksummed, not signed.** Anyone who can read the QR can
  relay it; a payment request is not proof of merchant identity. The buyer's
  page re-verifies the checksum before letting you pay it.
- **Settlement is simulated.** `settled` means "verified and recorded once,
  on this server." No PayPal capture happens on the offline path; the PayPal
  flow (create → approve → capture → webhook) remains the only path where
  Sandbox money actually moves.

## Endpoints

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/offline/request` | seller (own desk) | issue a request for a draft order |
| `GET /api/offline/requests` | seller | list with `pending / confirmed / redeemed / expired` |
| `GET /api/offline/share/:id` | anyone with the link | the request body for the buyer page |
| `POST /api/offline/confirm` | buyer | hand over the signed confirmation; verifies, does not settle |
| `POST /api/offline/redeem` | seller (owner) | verify again, record once, settle |

The buyer page is `/pay.html?r=<request id>`; it also accepts a pasted
payload (for QR scans on another device). Requests default to a 60-minute
window (`OFFLINE_REQUEST_TTL_MINUTES`).

## UI honesty rules

- The buyer page's states are "signed", "handed over", "settlement pending" —
  never "paid".
- The seller's redeem response and the activity feed both carry
  "simulated settlement" wording.
- The Reserve panel is tagged `SIMULATED SPENDING POWER`; the offline screen
  is tagged `SIGNED HANDOFF · SIMULATED SETTLEMENT`.

## Tests

`npm test` → `tests/offline.test.mjs` covers: browser↔server wire-format
interop in both directions, checksum tampering, altered confirmation fields,
forged authorizations, wrong-request binding, confirm/redeem replay, spend
over the allowance, expiry, owner scoping, and the cloned-device double-spend
(the second redemption of a reused sequence is refused).
