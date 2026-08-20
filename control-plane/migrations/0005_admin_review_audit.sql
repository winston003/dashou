CREATE TABLE IF NOT EXISTS pilot_admin_audit_events (
  audit_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_period TEXT,
  to_period TEXT,
  reason TEXT,
  note TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pilot_admin_audit_application_idx
  ON pilot_admin_audit_events(application_id, created_at);

CREATE INDEX IF NOT EXISTS pilot_admin_audit_created_idx
  ON pilot_admin_audit_events(created_at DESC);
