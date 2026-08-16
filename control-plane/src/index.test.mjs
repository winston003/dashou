import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import test from "node:test";
import { route } from "./index.js";

const ADMIN_TOKEN = "pilot-admin-token-for-worker-test";
const { privateKeyPem, publicKeyPem } = testKeyPair();
const ACTIVATION_KEY = Buffer.alloc(32, 7).toString("base64url");

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

test("device application can be approved, safely activated, confirmed and revoked", async () => {
  const db = new FakeD1();
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    PILOT_LEASE_PRIVATE_KEY: privateKeyPem,
    PILOT_LEASE_PUBLIC_KEY: publicKeyPem,
    DASHOU_ACTIVATION_KEY: ACTIVATION_KEY,
    DASHOU_CONTROL_PUBLIC_URL: "https://control.example",
    DEVICE_PROVISIONER: async (_env, application) => ({
      tunnelId: `tunnel-${application.applicationId}`,
      tunnelToken: "cloudflare-tunnel-secret-for-device",
      hostname: "device-alice.warmbyte.studio",
      publicBaseUrl: "https://device-alice.warmbyte.studio",
    }),
  };
  const applicationToken = "A".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"b".repeat(24)}`,
      deviceName: "Alice Mac",
      platform: "macos-arm64",
    },
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.status, "pending");

  const duplicate = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"b".repeat(24)}`,
      deviceName: "Alice Mac",
      platform: "macos-arm64",
    },
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).applicationId, created.applicationId);

  const unauthorized = await request("GET", `/applications/${created.applicationId}`, { env });
  assert.equal(unauthorized.status, 401);
  const pending = await request("GET", `/applications/${created.applicationId}`, { env, token: applicationToken });
  assert.equal((await pending.json()).status, "pending");

  const list = await request("GET", "/admin/applications?status=pending", { env, token: ADMIN_TOKEN });
  const listed = await list.json();
  assert.equal(listed.applications.length, 1);
  assert.equal(listed.applications[0].deviceName, "Alice Mac");
  assert.equal("applicationToken" in listed.applications[0], false);

  const approve = await request("POST", `/admin/applications/${created.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month" },
  });
  assert.equal(approve.status, 200, JSON.stringify(await approve.clone().json()));
  const approved = await approve.json();
  assert.equal(approved.status, "approved");
  assert.equal(approved.period, "month");
  assert.equal(approved.mcpUrl, "https://device-alice.warmbyte.studio/mcp");
  assert.equal("tunnelToken" in approved, false);
  const stored = db.applications.get(created.applicationId);
  assert.equal(stored.activation_ciphertext.startsWith("v1."), true);
  assert.equal(stored.activation_ciphertext.includes("cloudflare-tunnel-secret"), false);

  const activation = await request("POST", `/applications/${created.applicationId}/activate`, { env, token: applicationToken });
  assert.equal(activation.status, 200);
  const activatedSecrets = await activation.json();
  assert.equal(activatedSecrets.tunnelToken, "cloudflare-tunnel-secret-for-device");
  assert.equal(activatedSecrets.mcpUrl, "https://device-alice.warmbyte.studio/mcp");
  assert.equal(typeof activatedSecrets.pilotToken, "string");
  assert.equal(activatedSecrets.pilotPublicKeyPem, publicKeyPem.trim());
  assert.equal(typeof activatedSecrets.activationReceipt, "string");

  const retryActivation = await request("POST", `/applications/${created.applicationId}/activate`, { env, token: applicationToken });
  assert.equal((await retryActivation.json()).pilotToken, activatedSecrets.pilotToken);

  const confirm = await request("POST", `/applications/${created.applicationId}/activate/confirm`, {
    env,
    token: applicationToken,
    body: { activationReceipt: activatedSecrets.activationReceipt },
  });
  assert.equal(confirm.status, 200);
  assert.equal((await confirm.json()).status, "activated");
  assert.equal(db.applications.get(created.applicationId).activation_ciphertext, null);
  const consumed = await request("POST", `/applications/${created.applicationId}/activate`, { env, token: applicationToken });
  assert.equal(consumed.status, 410);

  const policy = await request("GET", "/pilot-policy", { env, token: activatedSecrets.pilotToken });
  assert.equal(policy.status, 200);
  stored.expires_at = "2020-01-01T00:00:00.000Z";
  const expired = await request("GET", `/applications/${created.applicationId}`, { env, token: applicationToken });
  assert.equal((await expired.json()).status, "expired");
  const renewal = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"b".repeat(24)}`,
      deviceName: "Alice Mac",
      platform: "macos-arm64",
    },
  });
  assert.equal(renewal.status, 201);
  assert.notEqual((await renewal.json()).applicationId, created.applicationId);
  const revoke = await request("POST", `/admin/applications/${created.applicationId}/revoke`, {
    env,
    token: ADMIN_TOKEN,
    body: {},
  });
  assert.equal(revoke.status, 200);
  const revokedPolicy = await request("GET", "/pilot-policy", { env, token: activatedSecrets.pilotToken });
  assert.equal(revokedPolicy.status, 401);
});

test("pending device application can be rejected with a user-facing reason", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const applicationToken = "C".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"d".repeat(24)}`,
      deviceName: "Demo PC",
      platform: "windows-x64",
    },
  });
  const created = await create.json();
  const reject = await request("POST", `/admin/applications/${created.applicationId}/reject`, {
    env,
    token: ADMIN_TOKEN,
    body: { reason: "请联系客服核对设备" },
  });
  assert.equal(reject.status, 200);
  const status = await request("GET", `/applications/${created.applicationId}`, { env, token: applicationToken });
  assert.deepEqual(await status.json(), {
    applicationId: created.applicationId,
    status: "rejected",
    createdAt: created.createdAt,
    rejectedAt: (await reject.clone().json()).rejectedAt,
    reason: "请联系客服核对设备",
  });
});

test("admin can inspect a safe application timeline but unauthenticated callers cannot", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const applicationToken = "T".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"t".repeat(24)}`,
      deviceName: "Timeline Mac",
      platform: "macos-arm64",
    },
  });
  const created = await create.json();
  const unauthorized = await request("GET", `/admin/applications/${created.applicationId}`, { env });
  assert.equal(unauthorized.status, 401);
  const response = await request("GET", `/admin/applications/${created.applicationId}`, { env, token: ADMIN_TOKEN });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.application.applicationId, created.applicationId);
  assert.equal(payload.application.createdAt, created.createdAt);
  assert.equal(payload.application.updatedAt, created.createdAt);
  assert.equal(payload.application.applicationToken, undefined);
  assert.equal(payload.application.activationCiphertext, undefined);
  assert.equal(JSON.stringify(payload).includes(applicationToken), false);
});

test("failed device provisioning returns the application to pending for a safe retry", async () => {
  const db = new FakeD1();
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    DEVICE_PROVISIONER: async () => { throw new Error("simulated provider outage"); },
  };
  const applicationToken = "G".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"h".repeat(24)}`,
      deviceName: "Retry PC",
      platform: "windows-x64",
    },
  });
  const created = await create.json();
  const approve = await request("POST", `/admin/applications/${created.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "week" },
  });
  assert.equal(approve.status, 502);
  assert.equal(db.applications.get(created.applicationId).status, "pending");
});

test("new device applications are rate limited without blocking idempotent retries", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  let first;
  for (let index = 0; index < 10; index += 1) {
    const token = String(index).padStart(43, "E");
    const response = await request("POST", "/applications", {
      env,
      body: {
        applicationToken: token,
        deviceId: `dev_${String(index).padStart(24, "f")}`,
        deviceName: `Device ${index}`,
        platform: "macos-arm64",
      },
    });
    assert.equal(response.status, 201);
    if (index === 0) first = { token, body: await response.json() };
  }
  const limited = await request("POST", "/applications", {
    env,
    body: {
      applicationToken: "F".repeat(43),
      deviceId: `dev_${"9".repeat(24)}`,
      deviceName: "Device blocked",
      platform: "macos-arm64",
    },
  });
  assert.equal(limited.status, 429);
  const retry = await request("POST", "/applications", {
    env,
    body: {
      applicationToken: first.token,
      deviceId: `dev_${String(0).padStart(24, "f")}`,
      deviceName: "Device 0",
      platform: "macos-arm64",
    },
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).applicationId, first.body.applicationId);
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
    version: "0.1.3-rc.2",
    buildSha: "abc123",
  });
});

test("admin reset requires authorization and explicit confirmation, then deletes registered Dashou resources", async () => {
  const db = new FakeD1();
  db.rows.set("pilot-test", { account_id: "pilot-test", token_hash: "hash" });
  db.rateLimits.set("network.hour", 3);
  db.applications.set("req_abcdefghijklmnop", {
    application_id: "req_abcdefghijklmnop",
    tunnel_id: "259c5a2a-ae41-4bd0-a189-bd84da4065fb",
    hostname: "device-test.warmbyte.studio",
    created_at: "2026-08-16T00:00:00.000Z",
  });
  const deleted = [];
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    DEVICE_DEPROVISIONER: async (_env, device) => { deleted.push(device); return device; },
  };
  assert.equal((await request("POST", "/admin/reset", { env, body: { confirm: "DELETE_ALL_DASHOU_PILOT_DATA" } })).status, 401);
  assert.equal((await request("POST", "/admin/reset", { env, token: ADMIN_TOKEN, body: { confirm: "no" } })).status, 400);
  const reset = await request("POST", "/admin/reset", { env, token: ADMIN_TOKEN, body: { confirm: "DELETE_ALL_DASHOU_PILOT_DATA" } });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { reset: true, deletedDevices: 1 });
  assert.deepEqual(deleted, [{
    tunnelId: "259c5a2a-ae41-4bd0-a189-bd84da4065fb",
    hostname: "device-test.warmbyte.studio",
  }]);
  assert.equal(db.rows.size, 0);
  assert.equal(db.applications.size, 0);
  assert.equal(db.rateLimits.size, 0);
  const repeated = await request("POST", "/admin/reset", { env, token: ADMIN_TOKEN, body: { confirm: "DELETE_ALL_DASHOU_PILOT_DATA" } });
  assert.deepEqual(await repeated.json(), { reset: true, deletedDevices: 0 });
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
  applications = new Map();
  rateLimits = new Map();

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const snapshotRows = structuredClone(this.rows);
    const snapshotApplications = structuredClone(this.applications);
    const snapshotRateLimits = structuredClone(this.rateLimits);
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.rows = snapshotRows;
      this.applications = snapshotApplications;
      this.rateLimits = snapshotRateLimits;
      throw error;
    }
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
    if (this.sql.includes("FROM pilot_application_rate_limits")) {
      return { attempts: this.db.rateLimits.get(`${this.values[0]}.${this.values[1]}`) ?? 0 };
    }
    if (this.sql.includes("FROM pilot_applications")) {
      if (this.sql.includes("WHERE device_id")) {
        return [...this.db.applications.values()].find((row) =>
          row.device_id === this.values[0] && ["pending", "provisioning", "approved", "activated"].includes(row.status)
        ) ?? null;
      }
      if (this.sql.includes("application_token_hash = ?2")) {
        const row = this.db.applications.get(this.values[0]);
        return row?.application_token_hash === this.values[1] ? row : null;
      }
      if (this.sql.includes("WHERE application_id")) return this.db.applications.get(this.values[0]) ?? null;
    }
    if (this.sql.includes("WHERE token_hash")) {
      return [...this.db.rows.values()].find((row) => row.token_hash === this.values[0]) ?? null;
    }
    if (this.sql.includes("WHERE account_id")) return this.db.rows.get(this.values[0]) ?? null;
    return null;
  }

  async all() {
    if (this.sql.includes("FROM pilot_applications")) {
      const rows = [...this.db.applications.values()];
      return { results: this.sql.includes("WHERE status = ?1") ? rows.filter((row) => row.status === this.values[0]) : rows };
    }
    return { results: [...this.db.rows.values()] };
  }

  async run() {
    if (this.sql === "DELETE FROM pilot_application_rate_limits") {
      const changes = this.db.rateLimits.size;
      this.db.rateLimits.clear();
      return result(changes);
    }
    if (this.sql === "DELETE FROM pilot_applications") {
      const changes = this.db.applications.size;
      this.db.applications.clear();
      return result(changes);
    }
    if (this.sql === "DELETE FROM pilot_accounts") {
      const changes = this.db.rows.size;
      this.db.rows.clear();
      return result(changes);
    }
    if (this.sql.startsWith("INSERT INTO pilot_application_rate_limits")) {
      const key = `${this.values[0]}.${this.values[1]}`;
      this.db.rateLimits.set(key, (this.db.rateLimits.get(key) ?? 0) + 1);
      return result(1);
    }
    if (this.sql.startsWith("INSERT INTO pilot_applications")) {
      const [applicationId, applicationTokenHash, deviceId, deviceName, platform, contact, createdAt] = this.values;
      this.db.applications.set(applicationId, {
        application_id: applicationId,
        application_token_hash: applicationTokenHash,
        device_id: deviceId,
        device_name: deviceName,
        platform,
        contact,
        status: "pending",
        period: null,
        account_id: null,
        tunnel_id: null,
        hostname: null,
        activation_ciphertext: null,
        activation_started_at: null,
        approved_at: null,
        expires_at: null,
        activated_at: null,
        rejected_at: null,
        rejection_reason: null,
        revoked_at: null,
        provisioning_started_at: null,
        created_at: createdAt,
        updated_at: createdAt,
      });
      return result(1);
    }
    if (this.sql.startsWith("INSERT INTO pilot_accounts")) {
      const [accountId, tokenHash, third, fourth, fifth] = this.values;
      const enabled = this.values.length === 4 ? 1 : third;
      const expiresAt = this.values.length === 4 ? third : fourth;
      const createdAt = this.values.length === 4 ? fourth : fifth;
      if (this.db.rows.has(accountId)) throw new Error("UNIQUE constraint failed: pilot_accounts.account_id");
      this.db.rows.set(accountId, { account_id: accountId, token_hash: tokenHash, enabled, expires_at: expiresAt, created_at: createdAt, revoked_at: null });
      return result(1);
    }
    if (this.sql.startsWith("UPDATE pilot_accounts SET enabled = ?1")) {
      const [enabled, expiresAt, revokedAt, accountId] = this.values;
      const row = this.db.rows.get(accountId);
      row.enabled = enabled;
      row.expires_at = expiresAt;
      row.revoked_at = revokedAt;
      return result(1);
    }
    if (this.sql.startsWith("UPDATE pilot_accounts SET enabled = 0")) {
      const [revokedAt, accountId] = this.values;
      const row = this.db.rows.get(accountId);
      if (!row) return result(0);
      row.enabled = 0;
      row.revoked_at ??= revokedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'provisioning'")) {
      const [startedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "pending") return result(0);
      row.status = "provisioning";
      row.provisioning_started_at = startedAt;
      row.updated_at = startedAt;
      return result(1);
    }
    if (this.sql.includes("SET provisioning_started_at") && this.sql.includes("status = 'provisioning'")) {
      const [startedAt, applicationId, expectedStartedAt] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "provisioning" || row.provisioning_started_at !== expectedStartedAt) return result(0);
      row.provisioning_started_at = startedAt;
      row.updated_at = startedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'pending'")) {
      const [updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "provisioning") return result(0);
      row.status = "pending";
      row.provisioning_started_at = null;
      row.updated_at = updatedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'approved'")) {
      const [period, accountId, tunnelId, hostname, ciphertext, approvedAt, expiresAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "provisioning") return result(0);
      Object.assign(row, { status: "approved", period, account_id: accountId, tunnel_id: tunnelId, hostname, activation_ciphertext: ciphertext, approved_at: approvedAt, expires_at: expiresAt, updated_at: approvedAt });
      return result(1);
    }
    if (this.sql.includes("SET activation_started_at")) {
      const [startedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "approved") return result(0);
      row.activation_started_at ??= startedAt;
      row.updated_at = startedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'activated'")) {
      const [activatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "approved") return result(0);
      row.status = "activated";
      row.activated_at = activatedAt;
      row.activation_ciphertext = null;
      row.updated_at = activatedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'rejected'")) {
      const [rejectedAt, reason, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "pending") return result(0);
      Object.assign(row, { status: "rejected", rejected_at: rejectedAt, rejection_reason: reason, updated_at: rejectedAt });
      return result(1);
    }
    if (this.sql.includes("SET status = 'revoked'")) {
      const [revokedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row) return result(0);
      Object.assign(row, { status: "revoked", revoked_at: revokedAt, activation_ciphertext: null, updated_at: revokedAt });
      return result(1);
    }
    if (this.sql.includes("SET status = 'expired'")) {
      const [updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || !["approved", "activated"].includes(row.status)) return result(0);
      Object.assign(row, { status: "expired", activation_ciphertext: null, updated_at: updatedAt });
      return result(1);
    }
    throw new Error(`Unsupported fake D1 statement: ${this.sql}`);
  }
}

function result(changes) {
  return { success: true, meta: { changes } };
}
