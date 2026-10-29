-- Activity feed: what happened on this desk. Written by the server only
-- (checkout created, capture completed, webhook received, offline redeemed).
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'general',
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  amount     REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX events_user ON events (user_id, created_at DESC);
