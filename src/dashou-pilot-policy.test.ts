import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPilotAccessGate,
  createSignedLeaseForNode,
  pilotAccessStatus,
  type DashouPilotLeasePayload,
  type DashouPilotRemoteConfig,
} from "./dashou-pilot-policy.js";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("pilot policy fails closed when disabled or expired", () => {
  assert.equal(pilotAccessStatus({ enabled: false, accountId: "alice" }).allowed, false);
  assert.equal(pilotAccessStatus({ enabled: true, expiresAt: "2020-01-01T00:00:00.000Z" }).reason, "expired");
  assert.equal(pilotAccessStatus({ enabled: true, expiresAt: "not-a-date" }).reason, "invalid-expiry");
  assert.equal(pilotAccessStatus({ enabled: true, expiresAt: "2030-01-01T00:00:00.000Z" }, Date.parse("2029-01-01T00:00:00.000Z")).allowed, true);
});

test("remote control is off the status hot path and refresh authenticates a signed lease", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let calls = 0;
  const now = Date.parse("2026-08-13T00:00:00.000Z");
  const remote = remoteConfig();
  const lease = signedLease({
    accountId: "pilot-alice",
    enabled: true,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuedAt: "2026-08-13T00:00:00.000Z",
  });
  const gate = createPilotAccessGate(
    { enabled: true, accountId: "local-owner" },
    remote,
    {
      now: () => now,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify({ lease }), { status: 200 });
      },
    },
  );

  assert.deepEqual(gate.status(), { allowed: false, reason: "remote-unavailable" });
  assert.deepEqual(await gate.refresh(), {
    allowed: true,
    reason: "enabled",
    accountId: "pilot-alice",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.deepEqual(gate.status(), {
    allowed: true,
    reason: "enabled",
    accountId: "pilot-alice",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(calls, 1);
  assert.deepEqual(requests, [{ url: "https://control.example/pilot", authorization: "Bearer control-secret" }]);
});

test("a valid cached lease keeps the runtime available during a temporary control-plane outage", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-pilot-lease-"));
  let now = Date.parse("2026-08-13T00:00:00.000Z");
  const remote = remoteConfig(stateDir);
  const lease = signedLease({
    accountId: "pilot-alice",
    enabled: true,
    expiresAt: "2026-08-13T01:00:00.000Z",
    issuedAt: "2026-08-13T00:00:00.000Z",
  });
  try {
    const first = createPilotAccessGate(undefined, remote, {
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ lease }), { status: 200 }),
    });
    await first.refresh();
    const second = createPilotAccessGate(undefined, remote, {
      now: () => now,
      fetchImpl: async () => new Response("offline", { status: 503 }),
    });
    assert.equal(second.status().allowed, true);
    now = Date.parse("2026-08-13T01:00:00.000Z");
    assert.deepEqual(second.status(), {
      allowed: false,
      reason: "expired",
      accountId: "pilot-alice",
      expiresAt: "2026-08-13T01:00:00.000Z",
    });
    assert.match(await readFile(join(stateDir, "pilot-lease.json"), "utf8"), /signedLease/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a valid cached lease does not make startup wait for the control plane", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-pilot-startup-"));
  const now = Date.parse("2026-08-13T00:00:00.000Z");
  const remote = remoteConfig(stateDir);
  const lease = signedLease({
    accountId: "pilot-alice",
    enabled: true,
    expiresAt: "2026-08-13T01:00:00.000Z",
    issuedAt: "2026-08-13T00:00:00.000Z",
  });
  try {
    const first = createPilotAccessGate(undefined, remote, {
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ lease }), { status: 200 }),
    });
    await first.refresh();

    let calls = 0;
    const restarted = createPilotAccessGate(undefined, remote, {
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        return new Response("offline", { status: 503 });
      },
    });
    restarted.start();
    assert.deepEqual(restarted.status(), {
      allowed: true,
      reason: "enabled",
      accountId: "pilot-alice",
      expiresAt: "2026-08-13T01:00:00.000Z",
    });
    assert.equal(calls, 0);
    restarted.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("local and remote expiry resolve to the earlier time", async () => {
  let now = Date.parse("2026-08-13T00:00:00.000Z");
  const remote = remoteConfig();
  const lease = signedLease({
    accountId: "pilot-alice",
    enabled: true,
    expiresAt: "2026-08-13T02:00:00.000Z",
    issuedAt: "2026-08-13T00:00:00.000Z",
  });
  const gate = createPilotAccessGate(
    { enabled: true, accountId: "local-owner", expiresAt: "2026-08-13T01:00:00.000Z" },
    remote,
    {
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ lease }), { status: 200 }),
    },
  );
  await gate.refresh();
  assert.equal(gate.status().expiresAt, "2026-08-13T01:00:00.000Z");
  now = Date.parse("2026-08-13T01:00:00.000Z");
  assert.equal(gate.status().reason, "expired");
});

test("invalid or rejected remote leases never become local authority", async () => {
  const remote = remoteConfig();
  const malformed = createPilotAccessGate(undefined, remote, {
    fetchImpl: async () => new Response(JSON.stringify({ accountId: "alice" }), { status: 200 }),
  });
  assert.deepEqual(await malformed.refresh(), { allowed: false, reason: "invalid-remote-policy" });
  assert.deepEqual(malformed.status(), { allowed: false, reason: "remote-unavailable" });

  const rejected = createPilotAccessGate(undefined, remote, {
    fetchImpl: async () => new Response("no", { status: 401 }),
  });
  assert.deepEqual(await rejected.refresh(), { allowed: false, reason: "remote-unavailable" });
});

function remoteConfig(stateDir?: string): DashouPilotRemoteConfig {
  return {
    url: "https://control.example/pilot",
    token: "control-secret",
    publicKeyPem,
    cacheTtlMs: 1_000,
    ...(stateDir ? { stateDir } : {}),
  };
}

function signedLease(payload: DashouPilotLeasePayload): string {
  return createSignedLeaseForNode(payload, privateKeyPem);
}
