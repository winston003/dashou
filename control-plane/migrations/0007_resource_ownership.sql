ALTER TABLE pilot_applications ADD COLUMN subject_id TEXT;
ALTER TABLE pilot_applications ADD COLUMN resource_state TEXT
  CHECK (resource_state IN ('provisioning', 'active', 'needs_reconcile', 'deleting', 'delete_failed', 'deleted'));
ALTER TABLE pilot_applications ADD COLUMN resource_error TEXT;
ALTER TABLE pilot_applications ADD COLUMN deprovisioned_at TEXT;

-- Existing connections did not have an administrator-assigned customer
-- identity. Give every historical resource a distinct legacy owner so the
-- migration never merges or deletes live customer resources automatically.
UPDATE pilot_applications
SET subject_id = 'legacy-' || lower(replace(application_id, 'req_', '')),
    resource_state = 'active'
WHERE tunnel_id IS NOT NULL AND hostname IS NOT NULL;

-- This is the hard resource guard. Revoked and expired applications retain an
-- active slot until their Cloudflare Tunnel and DNS record are physically
-- retired, so a reversible status edit cannot accidentally free quota.
CREATE UNIQUE INDEX IF NOT EXISTS pilot_applications_subject_resource_idx
  ON pilot_applications(subject_id)
  WHERE subject_id IS NOT NULL
    AND resource_state IN ('provisioning', 'active', 'needs_reconcile', 'deleting', 'delete_failed');

CREATE INDEX IF NOT EXISTS pilot_applications_subject_history_idx
  ON pilot_applications(subject_id, created_at);
