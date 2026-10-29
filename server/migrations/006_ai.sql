-- Phase 2: the AI brain's storage — short-term chat context, seller facts,
-- seller expenses (for code-computed revenue/expense totals) and reminders
-- created through Ask Byte. Orders gain an optional customer name, which the
-- extractor can pull out of a customer's message and recall can search.

CREATE TABLE chat_turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX chat_turns_user ON chat_turns (user_id, created_at DESC);

CREATE TABLE facts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'learned',
  created_at INTEGER NOT NULL
);

CREATE INDEX facts_user ON facts (user_id, created_at DESC);

CREATE TABLE expenses (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  what       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'other',
  spent_at   INTEGER NOT NULL
);

CREATE INDEX expenses_user ON expenses (user_id, spent_at DESC);

CREATE TABLE reminders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  order_id   TEXT REFERENCES orders (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX reminders_user ON reminders (user_id, due_at);

ALTER TABLE orders ADD COLUMN customer TEXT;
