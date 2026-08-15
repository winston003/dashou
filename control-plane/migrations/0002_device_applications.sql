CREATE TABLE IF NOT EXISTS pilot_applications (
  application_id TEXT PRIMARY KEY,
  application_token_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'approved', 'rejected', 'activated', 'expired', 'revoked')),
  period TEXT CHECK (period IN ('week', 'month', 'quarter', 'year')),
  account_id TEXT,
  tunnel_id TEXT,
  hostname TEXT,
  activation_ciphertext TEXT,
  activation_started_at TEXT,
  approved_at TEXT,
  expires_at TEXT,
  activated_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  revoked_at TEXT,
  provisioning_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS pilot_applications_device_id_active_idx
  ON pilot_applications(device_id)
  WHERE status IN ('pending', 'provisioning', 'approved', 'activated');

CREATE INDEX IF NOT EXISTS pilot_applications_status_created_idx
  ON pilot_applications(status, created_at);

CREATE INDEX IF NOT EXISTS pilot_applications_token_hash_idx
  ON pilot_applications(application_token_hash);

CREATE TABLE IF NOT EXISTS pilot_application_rate_limits (
  network_hash TEXT NOT NULL,
  window_start TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network_hash, window_start)
);
