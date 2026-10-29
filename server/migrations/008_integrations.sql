-- Phase 4: Butler's automation layer, ported.
--
-- mcp_connections  external MCP servers; the address+key blob is stored only
--                  vault-locked (AES-GCM), never in plaintext.
-- recipes          seller instructions plus a trigger: manual, a schedule,
--                  an order event, or a secret webhook link.
-- recipe_runs      one attempt; status 'waiting' IS the approval gate — the
--                  write step's tool+args sit here until the seller confirms.
-- jobs             SQLite-backed queue with retry/backoff; every trigger
--                  enqueues, one sweeper drains it.

CREATE TABLE mcp_connections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  host       TEXT NOT NULL,
  secret     TEXT NOT NULL,               -- v1:<base64 iv+ciphertext>, vault.mjs
  tools      TEXT NOT NULL DEFAULT '[]',  -- JSON array of tool descriptors
  rules      TEXT NOT NULL DEFAULT '{}',  -- JSON {toolName: auto|ask|off}
  checked_at INTEGER,
  error      TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX mcp_connections_name ON mcp_connections (user_id, name);

CREATE TABLE mcp_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id TEXT,
  connection    TEXT NOT NULL DEFAULT '',
  tool          TEXT NOT NULL DEFAULT '',
  args          TEXT NOT NULL DEFAULT '{}',
  asked         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'done',
  result        TEXT NOT NULL DEFAULT '',
  at            INTEGER NOT NULL
);

CREATE INDEX mcp_calls_user ON mcp_calls (user_id, at DESC);

CREATE TABLE recipes (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  instructions   TEXT NOT NULL,
  trigger_type   TEXT NOT NULL DEFAULT 'manual',   -- manual | schedule | order_event | webhook
  trigger_config TEXT NOT NULL DEFAULT '{}',       -- {run_at,run_days} | {event} | {}
  hook_hash      TEXT,                             -- sha256 of the webhook token
  hook_secret    TEXT,                             -- vault-locked token
  scheduled_on   TEXT,                             -- last day it ran by schedule
  last_run_at    INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX recipes_name ON recipes (user_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX recipes_hook ON recipes (hook_hash) WHERE hook_hash IS NOT NULL;

CREATE TABLE recipe_runs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipe_id     TEXT NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  trigger_kind  TEXT NOT NULL DEFAULT 'manual',
  status        TEXT NOT NULL DEFAULT 'running',   -- running | done | waiting | failed | declined
  say           TEXT NOT NULL DEFAULT '',
  waiting_tool  TEXT,                              -- approval gate payload
  waiting_args  TEXT,
  event_text    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE INDEX recipe_runs_user ON recipe_runs (user_id, created_at DESC);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                      -- 'recipe_run'
  payload      TEXT NOT NULL DEFAULT '{}',
  run_at       INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  state        TEXT NOT NULL DEFAULT 'queued',     -- queued | running | done | failed
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX jobs_due ON jobs (state, run_at);
