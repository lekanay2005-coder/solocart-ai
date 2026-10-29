-- Local accounts. `kind = 'device'` rows are transparent per-browser identities
-- created when nobody is signed in, so the seller desk keeps working without an
-- account; their rows are merged into the real account on register/sign-in.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'local',
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  salt          TEXT,
  password_hash TEXT,
  created_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX users_email_local ON users (email) WHERE kind = 'local';
CREATE INDEX users_kind ON users (kind);
