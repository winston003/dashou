import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import test from "node:test";
import { route } from "./index.js";

const ADMIN_TOKEN = "pilot-admin-token-for-worker-test";
const { privateKeyPem, publicKeyPem } = testKeyPair();

test("Worker control plane creates, disables and revokes a pilot account", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN, PILOT_LEASE_PRIVATE_KEY: privateKeyPem, PILOT_LEASE_TTL_SECONDS: "900", DASHOU_BUILD_SHA: "test-build-sha" };
  const create = await request("POST", "/admin/pilot/accounts", {
    env,
    body: { accountId: "pilot-alice", expiresAt: "2099-01-01T00:00:00.000Z" },
    token: ADMIN_TOKEN,
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(typeof created.token, "string");

  const policy = await request("GET", "/pilot-policy", { env, token: created.token });
  assert.equal(policy.status, 200);
  const leaseResponse = await policy.json();
  assert.equal(typeof leaseResponse.lease, "string");
  const encodedPayload = leaseResponse.lease.split(".")[0];
  assert.ok(encodedPayload);
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(payload.accountId, "pilot-alice");
  assert.equal(payload.enabled, true);
  assert.ok(Date.parse(payload.expiresAt) <= Date.now() + 901_000);
  assert.equal(typeof payload.issuedAt, "string");
  assert.equal(verifySignature(
    "RSA-SHA256",
    Buffer.from(encodedPayload, "ascii"),
    { key: createPublicKey(publicKeyPem), padding: 6, saltLength: 32 },
    Buffer.from(leaseResponse.lease.split(".")[1], "base64url"),
  ), true);

  const disable = await request("POST", "/admin/pilot/accounts/pilot-alice", {
    env,
    body: { enabled: false },
    token: ADMIN_TOKEN,
  });
  assert.equal(disable.status, 200);
  const disabled = await request("GET", "/pilot-policy", { env, token: created.token });
  const disabledLease = await disabled.json();
  assert.equal(JSON.parse(Buffer.from(disabledLease.lease.split(".")[0], "base64url").toString("utf8")).enabled, false);

  const revoke = await request("POST", "/admin/pilot/accounts/pilot-alice", {
    env,
    body: { revoke: true },
    token: ADMIN_TOKEN,
  });
  assert.equal(revoke.status, 200);
  const revoked = await request("GET", "/pilot-policy", { env, token: created.token });
  assert.equal(revoked.status, 401);
});

test("Worker control plane does not expose admin operations without the admin secret", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const response = await request("GET", "/admin/pilot/accounts", { env });
  assert.equal(response.status, 401);
});

test("expired accounts receive a signed disabled lease with a valid lease lifetime", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN, PILOT_LEASE_PRIVATE_KEY: privateKeyPem, PILOT_LEASE_TTL_SECONDS: "900" };
  const create = await request("POST", "/admin/pilot/accounts", {
    env,
    body: { accountId: "pilot-expired", expiresAt: "2020-01-01T00:00:00.000Z" },
    token: ADMIN_TOKEN,
  });
  const created = await create.json();
  const response = await request("GET", "/pilot-policy", { env, token: created.token });
  assert.equal(response.status, 200);
  const lease = await response.json();
  const payload = JSON.parse(Buffer.from(lease.lease.split(".")[0], "base64url").toString("utf8"));
  assert.equal(payload.enabled, false);
  assert.ok(Date.parse(payload.expiresAt) > Date.parse(payload.issuedAt));
});

test("Worker health exposes the deployment build SHA", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN, DASHOU_BUILD_SHA: "abc123" };
  const response = await request("GET", "/healthz", { env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    name: "dashou-pilot-control",
    version: "0.1.2-rc2",
    buildSha: "abc123",
  });
});

function testKeyPair() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function request(method, path, options) {
  const headers = new Headers({
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body ? { "content-type": "application/json" } : {}),
  });
  return route(new Request(`https://control.example${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }), options.env);
}

class FakeD1 {
  rows = new Map();

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  values = [];

  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql.includes("WHERE token_hash")) {
      return [...this.db.rows.values()].find((row) => row.token_hash === this.values[0]) ?? null;
    }
    if (this.sql.includes("WHERE account_id")) return this.db.rows.get(this.values[0]) ?? null;
    return null;
  }

  async all() {
    return { results: [...this.db.rows.values()] };
  }

  async run() {
    if (this.sql.startsWith("INSERT")) {
      const [accountId, tokenHash, enabled, expiresAt, createdAt] = this.values;
      this.db.rows.set(accountId, { account_id: accountId, token_hash: tokenHash, enabled, expires_at: expiresAt, created_at: createdAt, revoked_at: null });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE")) {
      const [enabled, expiresAt, revokedAt, accountId] = this.values;
      const row = this.db.rows.get(accountId);
      row.enabled = enabled;
      row.expires_at = expiresAt;
      row.revoked_at = revokedAt;
      return { success: true };
    }
    throw new Error(`Unsupported fake D1 statement: ${this.sql}`);
  }
}
