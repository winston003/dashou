-- These columns already exist in the deployed D1 baseline. Keep this migration
-- as a recorded no-op so Wrangler can advance the migration ledger without
-- attempting duplicate ALTER TABLE statements.
SELECT 1;
