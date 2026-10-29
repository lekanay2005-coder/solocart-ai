-- Phase 3: offline payments (Morrow port).
--
-- A request is a signed-payment-request payload the seller issues for a draft
-- order; a confirmation is the buyer's signed handoff (verified server-side);
-- a redemption is the seller's settle action, recorded once per authorization.
-- The two UNIQUE constraints are the replay guards:
--   * offline_requests.status advances pending -> confirmed -> redeemed and
--     updates refuse to fire from a stale status (confirmation replay),
--   * offline_redeemptions.(allowance_id, sequence) is the double-spend
--     guard: the same OfflineAuthorization can never redeem twice.
CREATE TABLE offline_requests (
  id                 TEXT PRIMARY KEY,             -- PaymentRequest.id (req_…)
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  order_id           TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  payload            TEXT NOT NULL,                -- base64 serializeRequest()
  request_json       TEXT NOT NULL,                -- canonical request object
  amount_minor       INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  confirmation_json  TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  confirmed_at       INTEGER,
  redeemed_at        INTEGER
);

CREATE INDEX offline_requests_user ON offline_requests (user_id, created_at DESC);
CREATE INDEX offline_requests_order ON offline_requests (order_id);

CREATE TABLE offline_redeemptions (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL UNIQUE REFERENCES offline_requests (id),
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  order_id            TEXT,
  allowance_id        TEXT NOT NULL,
  sequence            INTEGER NOT NULL,
  payer_public_key    TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  confirmation_json   TEXT NOT NULL,
  authorization_json  TEXT,
  channel             TEXT NOT NULL DEFAULT 'offline-reserve',
  redeemed_at         INTEGER NOT NULL,
  UNIQUE (allowance_id, sequence)                  -- double-spend guard
);

CREATE INDEX offline_redeemptions_user ON offline_redeemptions (user_id, redeemed_at DESC);
