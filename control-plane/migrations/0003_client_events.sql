CREATE TABLE IF NOT EXISTS pilot_client_events (
  application_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  error_code TEXT,
  app_version TEXT NOT NULL,
  client_unix_seconds INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (application_id, event_id)
);

CREATE INDEX IF NOT EXISTS pilot_client_events_received_idx
  ON pilot_client_events(received_at DESC);

CREATE INDEX IF NOT EXISTS pilot_client_events_application_idx
  ON pilot_client_events(application_id, received_at);
