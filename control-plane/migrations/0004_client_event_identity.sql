ALTER TABLE pilot_applications ADD COLUMN device_nickname TEXT;
ALTER TABLE pilot_applications ADD COLUMN device_fingerprint TEXT;

ALTER TABLE pilot_client_events ADD COLUMN device_nickname TEXT;
ALTER TABLE pilot_client_events ADD COLUMN device_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS pilot_applications_device_fingerprint_idx
  ON pilot_applications(device_fingerprint);
