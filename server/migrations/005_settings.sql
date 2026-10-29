-- Per-user server-side settings. Theme and the balance-hidden toggle stay in
-- the browser (they are device preferences); everything else lives here.
CREATE TABLE settings (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
