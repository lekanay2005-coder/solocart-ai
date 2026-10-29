-- Orders are server-side, per user. `status` follows the state machine in
-- server/orders.mjs (draft -> awaiting_buyer -> captured | failed | expired,
-- plus the offline branch added in phase 3).
CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'draft',
  currency            TEXT NOT NULL DEFAULT 'USD',
  items               TEXT NOT NULL DEFAULT '[]',
  shipping            REAL NOT NULL DEFAULT 0,
  item_total          REAL NOT NULL DEFAULT 0,
  total               REAL NOT NULL DEFAULT 0,
  note                TEXT NOT NULL DEFAULT '',
  source              TEXT NOT NULL DEFAULT 'local',
  paypal_order_id     TEXT,
  capture_request_id  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  expires_at          INTEGER
);

CREATE UNIQUE INDEX orders_paypal ON orders (paypal_order_id) WHERE paypal_order_id IS NOT NULL;
CREATE INDEX orders_user ON orders (user_id, created_at DESC);
CREATE INDEX orders_status ON orders (status);
