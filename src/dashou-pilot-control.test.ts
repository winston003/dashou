import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { DashouPilotControlStore } from "./dashou-pilot-control.js";
import { createDashouPilotControlServer, listenDashouPilotControlServer } from "./dashou-pilot-control-server.js";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const leasePrivateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("pilot control stores only token hashes and supports enable, disable and revoke", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-pilot-control-store-"));
  try {
    const store = new DashouPilotControlStore(stateDir);
    const created = store.createAccount("pilot-alice", "2099-01-01T00:00:00.000Z");
    assert.match(created.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(store.policyForToken(created.token), {
      accountId: "pilot-alice",
      enabled: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(store.policyForToken("wrong-token"), undefined);
    const raw = await readFile(join(stateDir, "pilot-control.json"), "utf8");
    assert.equal(raw.includes(created.token), false);
    assert.match(raw, /tokenHash/);

    store.setEnabled("pilot-alice", false);
    assert.equal(store.policyForToken(created.token)?.enabled, false);
    store.setEnabled("pilot-alice", true);
    store.revoke("pilot-alice");
    assert.equal(store.policyForToken(created.token), undefined);
    assert.throws(() => store.setEnabled("pilot-alice", true), /revoked/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("pilot control HTTP API protects admin operations and returns a policy", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-pilot-control-http-"));
  const running = createDashouPilotControlServer({
    host: "127.0.0.1",
    port: 0,
    stateDir,
    adminToken: "pilot-admin-token-that-is-long-enough",
    leasePrivateKeyPem,
    leaseTtlSeconds: 900,
  });
  const server = await listenDashouPilotControlServer(running);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await running.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${baseUrl}/admin/pilot/accounts`)).status, 401);
  const create = await fetch(`${baseUrl}/admin/pilot/accounts`, {
    method: "POST",
    headers: {
      authorization: "Bearer pilot-admin-token-that-is-long-enough",
      "content-type": "application/json",
    },
    body: JSON.stringify({ accountId: "pilot-alice", expiresAt: "2099-01-01T00:00:00.000Z" }),
  });
  assert.equal(create.status, 201);
  const account = await create.json() as { token: string };

  const policy = await fetch(`${baseUrl}/pilot-policy`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  assert.equal(policy.status, 200);
  const leaseResponse = await policy.json() as { lease: string };
  assert.match(leaseResponse.lease, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const disable = await fetch(`${baseUrl}/admin/pilot/accounts/pilot-alice`, {
    method: "POST",
    headers: {
      authorization: "Bearer pilot-admin-token-that-is-long-enough",
      "content-type": "application/json",
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.status, 200);
  const disabledPolicy = await fetch(`${baseUrl}/pilot-policy`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  const disabledLease = await disabledPolicy.json() as { lease: string };
  const disabledPayload = JSON.parse(Buffer.from(disabledLease.lease.split(".")[0], "base64url").toString("utf8")) as { accountId: string; enabled: boolean; expiresAt: string; issuedAt: string };
  assert.deepEqual(disabledPayload, {
    accountId: "pilot-alice",
    enabled: false,
    expiresAt: disabledPayload.expiresAt,
    issuedAt: disabledPayload.issuedAt,
  });
});

test("expired local accounts produce a signed disabled lease", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-pilot-control-expired-"));
  try {
    const store = new DashouPilotControlStore(stateDir);
    const account = store.createAccount("pilot-expired", "2020-01-01T00:00:00.000Z");
    const policy = store.policyForToken(account.token);
    assert.equal(policy?.enabled, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
