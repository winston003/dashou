import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateOwnerToken,
  loadDashouConfig,
  loadDashouFiles,
  writeDashouAuth,
  writeDashouConfig,
} from "./dashou-config.js";

test("Dashou config is isolated under its own directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-config-"));
  const env = { DASHOU_CONFIG_DIR: dir };
  writeDashouConfig({
    port: 7677,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://demo.warmbyte.studio",
  }, env);
  writeDashouAuth({ ownerToken: "a-very-long-dashou-owner-token" }, env);

  const files = loadDashouFiles(env);
  assert.equal(files.configPath, join(dir, "config.json"));
  assert.equal(files.authPath, join(dir, "auth.json"));

  const config = loadDashouConfig(env);
  assert.equal(config.port, 7677);
  assert.deepEqual(config.allowedRoots, [process.cwd()]);
  assert.equal(config.publicBaseUrl, "https://demo.warmbyte.studio");
  assert.deepEqual(config.oauth.scopes, ["dashou"]);
});

test("Dashou env configuration works without persisted files", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-env-config-"));
  const config = loadDashouConfig({
    DASHOU_CONFIG_DIR: dir,
    DASHOU_ALLOWED_ROOTS: process.cwd(),
    DASHOU_PUBLIC_BASE_URL: "https://demo.warmbyte.studio",
    DASHOU_OAUTH_OWNER_TOKEN: "a-very-long-dashou-owner-token",
  });
  assert.equal(config.port, 7677);
  assert.equal(config.host, "127.0.0.1");
  assert.ok(config.allowedHosts.includes("demo.warmbyte.studio"));
});

test("owner tokens have enough entropy", () => {
  const first = generateOwnerToken();
  const second = generateOwnerToken();
  assert.ok(first.length >= 40);
  assert.notEqual(first, second);
});

test("Tunnel token is loaded only from auth or environment", () => {
  const configDir = mkdtempSync(join(tmpdir(), "dashou-tunnel-config-test-"));
  writeDashouConfig({ allowedRoots: [process.cwd()], publicBaseUrl: "https://pilot.warmbyte.studio" }, { DASHOU_CONFIG_DIR: configDir });
  writeDashouAuth({ ownerToken: "owner-token-that-is-long-enough", tunnelToken: "stored-tunnel-token" }, { DASHOU_CONFIG_DIR: configDir });

  const stored = loadDashouConfig({ DASHOU_CONFIG_DIR: configDir });
  assert.equal(stored.tunnelToken, "stored-tunnel-token");
  assert.equal("tunnelToken" in loadDashouFiles({ DASHOU_CONFIG_DIR: configDir }).config, false);

  const overridden = loadDashouConfig({
    DASHOU_CONFIG_DIR: configDir,
    DASHOU_TUNNEL_TOKEN: "environment-tunnel-token",
  });
  assert.equal(overridden.tunnelToken, "environment-tunnel-token");
});
