import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPilotAdminConfig,
  pilotAdminConfigPath,
  writePilotAdminConfig,
} from "./pilot-admin-config.mjs";

test("pilot admin config is stored outside the repo with restrictive permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-pilot-admin-config-"));
  const env = { DASHOU_PILOT_ADMIN_CONFIG: join(dir, "pilot-admin.json") };
  const written = writePilotAdminConfig({
    controlPlaneUrl: "https://pilot.example.invalid",
    adminToken: "test-admin-token-that-is-not-real",
  }, env);

  assert.equal(written, pilotAdminConfigPath(env));
  assert.deepEqual(loadPilotAdminConfig(env), {
    controlPlaneUrl: "https://pilot.example.invalid",
    adminToken: "test-admin-token-that-is-not-real",
  });
  assert.equal(statSync(written).mode & 0o777, 0o600);
  assert.match(readFileSync(written, "utf8"), /"version": 1/);
});
