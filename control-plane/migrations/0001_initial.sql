CREATE TABLE IF NOT EXISTS pilot_accounts (
  account_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS pilot_accounts_token_hash_idx ON pilot_accounts(token_hash);
