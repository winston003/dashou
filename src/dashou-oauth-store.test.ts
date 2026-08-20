import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonOAuthStore } from "./dashou-oauth-store.js";

test("OAuth clients and tokens persist without SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-oauth-"));
  const store = new JsonOAuthStore(dir);
  const client = store.registerClient({
    redirect_uris: ["https://chatgpt.com/aip/g-123/oauth/callback"],
    client_name: "ChatGPT",
  }, ["chatgpt.com"]);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(store.saveTokenPair({
    accessTokenHash: "access",
    accessToken: { clientId: client.client_id, scopes: ["dashou"], expiresAt: now + 60 },
    refreshTokenHash: "refresh",
    refreshToken: { clientId: client.client_id, scopes: ["dashou"], expiresAt: now + 120 },
  }), true);
  store.close();

  const restored = new JsonOAuthStore(dir);
  assert.equal(restored.getClient(client.client_id)?.client_name, "ChatGPT");
  assert.equal(restored.getAccessToken("access")?.clientId, client.client_id);
  assert.equal(restored.getRefreshToken("refresh")?.clientId, client.client_id);
  assert.equal(restored.saveTokenPair({
    accessTokenHash: "access2",
    accessToken: { clientId: client.client_id, scopes: ["dashou"], expiresAt: now + 60 },
    refreshTokenHash: "refresh2",
    refreshToken: { clientId: client.client_id, scopes: ["dashou"], expiresAt: now + 120 },
  }, "refresh"), true);
  assert.equal(restored.getRefreshToken("refresh"), undefined);
});

test("OAuth redirect hosts are restricted", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-oauth-host-"));
  const store = new JsonOAuthStore(dir);
  assert.throws(() => store.registerClient({
    redirect_uris: ["https://evil.example/callback"],
    client_name: "Not allowed",
  }, ["chatgpt.com"]), /redirect_uri is not allowed/);
});

test("OAuth dynamic registration has a bounded persistent client count", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-oauth-limit-"));
  const store = new JsonOAuthStore(dir);
  for (let index = 0; index < 64; index += 1) {
    store.registerClient({
      redirect_uris: [`https://chatgpt.com/aip/g-${index}/oauth/callback`],
      client_name: `ChatGPT ${index}`,
    }, ["chatgpt.com"]);
  }
  assert.throws(() => store.registerClient({
    redirect_uris: ["https://chatgpt.com/aip/g-overflow/oauth/callback"],
    client_name: "ChatGPT overflow",
  }, ["chatgpt.com"]), /registered client limit/);
});

test("OAuth dynamic registration rejects oversized metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashou-oauth-metadata-"));
  const store = new JsonOAuthStore(dir);
  assert.throws(() => store.registerClient({
    redirect_uris: ["https://chatgpt.com/aip/g-large/oauth/callback"],
    client_name: "x".repeat(17 * 1024),
  }, ["chatgpt.com"]), /metadata is too large/);
});
