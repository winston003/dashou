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

test("public application fields reject terminal control characters", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const response = await request("POST", "/applications", {
    env,
    body: {
      applicationToken: "A".repeat(43),
      deviceId: `dev_${"c".repeat(24)}`,
      deviceName: "Alice\u001b[2JMac",
      platform: "macos-arm64",
    },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /control characters/);
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
      deviceName: "搭手·青柠-4827",
      deviceNickname: "搭手·青柠-4827",
      deviceFingerprint: "7F3A-91C2",
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
  assert.equal(listed.applications[0].deviceName, "搭手·青柠-4827");
  assert.equal(listed.applications[0].deviceNickname, "搭手·青柠-4827");
  assert.equal(listed.applications[0].deviceFingerprint, "7F3A-91C2");
  assert.equal("applicationToken" in listed.applications[0], false);

  const approve = await request("POST", `/admin/applications/${created.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", subjectId: "customer-alice" },
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
  const extension = await request("POST", `/admin/applications/${created.applicationId}/extend`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", reason: "申请人确认延长试用" },
  });
  assert.equal(extension.status, 200, JSON.stringify(await extension.clone().json()));
  assert.equal((await extension.json()).status, "activated");
  const extensionDetail = await request("GET", `/admin/applications/${created.applicationId}`, { env, token: ADMIN_TOKEN });
  assert.equal((await extensionDetail.json()).auditEvents.some((event) => event.action === "authorization_extended"), true);
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

test("admin can reopen a rejected application and preserves correction audit", async () => {
  const db = new FakeD1();
  const env = { DB: db, PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const applicationToken = "R".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"r".repeat(24)}`,
      deviceName: "Reopen Mac",
      platform: "macos-arm64",
    },
  });
  const created = await create.json();
  await request("POST", `/admin/applications/${created.applicationId}/reject`, {
    env,
    token: ADMIN_TOKEN,
    body: { reason: "误判" },
  });
  const reopened = await request("POST", `/admin/applications/${created.applicationId}/reopen`, {
    env,
    token: ADMIN_TOKEN,
    body: { reason: "已核对设备归属，纠正误判" },
  });
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).status, "pending");
  const detail = await request("GET", `/admin/applications/${created.applicationId}`, { env, token: ADMIN_TOKEN });
  const payload = await detail.json();
  assert.equal(payload.application.status, "pending");
  assert.deepEqual(new Set(payload.auditEvents.map((event) => event.action)), new Set(["rejected", "reopened"]));
  assert.equal(payload.auditEvents.find((event) => event.action === "reopened").reason, "已核对设备归属，纠正误判");
});

test("admin can change a not-yet-activated period, append notes and audit both", async () => {
  const db = new FakeD1();
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    PILOT_LEASE_PRIVATE_KEY: privateKeyPem,
    PILOT_LEASE_PUBLIC_KEY: publicKeyPem,
    DASHOU_ACTIVATION_KEY: ACTIVATION_KEY,
    DASHOU_CONTROL_PUBLIC_URL: "https://control.example",
    DEVICE_PROVISIONER: async () => ({
      tunnelId: "tunnel-period",
      tunnelToken: "period-tunnel-secret",
      hostname: "device-period.warmbyte.studio",
      publicBaseUrl: "https://device-period.warmbyte.studio",
    }),
  };
  const applicationToken = "P".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"p".repeat(24)}`,
      deviceName: "Period Mac",
      platform: "macos-arm64",
    },
  });
  const created = await create.json();
  await request("POST", `/admin/applications/${created.applicationId}/approve`, { env, token: ADMIN_TOKEN, body: { period: "week", subjectId: "customer-period" } });
  const changed = await request("POST", `/admin/applications/${created.applicationId}/period`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", reason: "申请人确认需要一个月" },
  });
  assert.equal(changed.status, 200, JSON.stringify(await changed.clone().json()));
  assert.equal((await changed.json()).period, "month");
  const note = await request("POST", `/admin/applications/${created.applicationId}/notes`, {
    env,
    token: ADMIN_TOKEN,
    body: { note: "已通过联系方式完成核对" },
  });
  assert.equal(note.status, 200);
  const detail = await request("GET", `/admin/applications/${created.applicationId}`, { env, token: ADMIN_TOKEN });
  const payload = await detail.json();
  assert.equal(payload.application.period, "month");
  assert.equal(payload.auditEvents.some((event) => event.action === "period_changed" && event.toPeriod === "month"), true);
  assert.equal(payload.auditEvents.some((event) => event.action === "note_added" && event.note === "已通过联系方式完成核对"), true);
});

test("admin can restore a revoked test account, edit its date, nickname and profile note", async () => {
  const db = new FakeD1();
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    PILOT_LEASE_PRIVATE_KEY: privateKeyPem,
    PILOT_LEASE_PUBLIC_KEY: publicKeyPem,
    DASHOU_ACTIVATION_KEY: ACTIVATION_KEY,
    DASHOU_CONTROL_PUBLIC_URL: "https://control.example",
    DEVICE_PROVISIONER: async () => ({
      tunnelId: "tunnel-reversible",
      tunnelToken: "reversible-tunnel-secret",
      hostname: "device-reversible.warmbyte.studio",
      publicBaseUrl: "https://device-reversible.warmbyte.studio",
    }),
  };
  const applicationToken = "V".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: { applicationToken, deviceId: `dev_${"v".repeat(24)}`, deviceName: "Test Windows", platform: "windows-x86_64" },
  });
  const created = await create.json();
  await request("POST", `/admin/applications/${created.applicationId}/approve`, { env, token: ADMIN_TOKEN, body: { period: "week", subjectId: "customer-reversible" } });
  const profile = await request("POST", `/admin/applications/${created.applicationId}/profile`, {
    env,
    token: ADMIN_TOKEN,
    body: { nickname: "搭手·小麦-3211", profileNote: "测试账号，允许恢复状态" },
  });
  assert.equal(profile.status, 200);
  const changedDate = await request("POST", `/admin/applications/${created.applicationId}/authorization`, {
    env,
    token: ADMIN_TOKEN,
    body: { expiresAt: "2099-01-01T00:00:00.000Z", reason: "测试账号调整授权日期" },
  });
  assert.equal(changedDate.status, 200, JSON.stringify(await changedDate.clone().json()));
  const activation = await request("POST", `/applications/${created.applicationId}/activate`, { env, token: applicationToken });
  const activationPayload = await activation.json();
  await request("POST", `/applications/${created.applicationId}/activate/confirm`, {
    env,
    token: applicationToken,
    body: { activationReceipt: activationPayload.activationReceipt },
  });
  await request("POST", `/admin/applications/${created.applicationId}/revoke`, { env, token: ADMIN_TOKEN, body: { reason: "测试撤销" } });
  assert.equal(db.applications.get(created.applicationId).status, "revoked");
  const restored = await request("POST", `/admin/applications/${created.applicationId}/restore`, {
    env,
    token: ADMIN_TOKEN,
    body: { reason: "误操作，恢复测试账号" },
  });
  assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));
  assert.equal((await restored.json()).status, "activated");
  const detail = await request("GET", `/admin/applications/${created.applicationId}`, { env, token: ADMIN_TOKEN });
  const payload = await detail.json();
  assert.equal(payload.application.nickname, "搭手·小麦-3211");
  assert.equal(payload.application.profileNote, "测试账号，允许恢复状态");
  assert.equal(payload.application.expiresAt, "2099-01-01T00:00:00.000Z");
  assert.equal(payload.auditEvents.some((event) => event.action === "profile_updated"), true);
  assert.equal(payload.auditEvents.some((event) => event.action === "authorization_changed"), true);
  assert.equal(payload.auditEvents.some((event) => event.action === "restored" && event.toStatus === "activated"), true);
  const policy = await request("GET", "/pilot-policy", { env, token: activationPayload.pilotToken });
  assert.equal(policy.status, 200);
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

test("client progress signals are authenticated, deduplicated and visible to the admin", async () => {
  const db = new FakeD1();
  const env = { DB: db, PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const applicationToken = "S".repeat(43);
  const create = await request("POST", "/applications", {
    env,
    body: {
      applicationToken,
      deviceId: `dev_${"s".repeat(24)}`,
      deviceName: "搭手·薄荷-1304",
      deviceNickname: "搭手·薄荷-1304",
      deviceFingerprint: "1A2B-3C4D",
      platform: "windows-x64",
    },
  });
  const created = await create.json();
  const events = [{
    eventId: "evt_abcdefghijklmnop",
    stage: "app_opened",
    outcome: "ok",
    appVersion: "0.1.3-rc.14",
    unixSeconds: 1_786_838_400,
    deviceNickname: "搭手·小麦-2045",
    deviceFingerprint: "0511-0713",
  }, {
    eventId: "evt_qrstuvwxyz12345",
    stage: "application_submitted",
    outcome: "ok",
    appVersion: "0.1.3-rc.14",
    unixSeconds: 1_786_838_401,
  }, {
    eventId: "evt_updateinstall12345",
    stage: "update_install_started",
    outcome: "ok",
    appVersion: "0.1.3-rc.14",
    unixSeconds: 1_786_838_402,
  }, {
    eventId: "evt_updatefailed12345",
    stage: "update_install_failed",
    outcome: "error",
    errorCode: "UPDATE_INSTALL_FAILED",
    appVersion: "0.1.3-rc.14",
    unixSeconds: 1_786_838_403,
  }];
  assert.equal((await request("POST", `/applications/${created.applicationId}/events`, { env, body: { events } })).status, 401);
  const accepted = await request("POST", `/applications/${created.applicationId}/events`, {
    env,
    token: applicationToken,
    body: { events },
  });
  assert.deepEqual(await accepted.json(), { accepted: 4 });
  await request("POST", `/applications/${created.applicationId}/events`, {
    env,
    token: applicationToken,
    body: { events },
  });
  const detail = await request("GET", `/admin/applications/${created.applicationId}`, { env, token: ADMIN_TOKEN });
  const payload = await detail.json();
  assert.equal(payload.events.length, 4);
  assert.equal(payload.events[0].stage, "app_opened");
  assert.equal(payload.events[0].deviceNickname, "搭手·小麦-2045");
  assert.equal(payload.events[0].deviceFingerprint, "0511-0713");
  assert.equal(payload.events[2].stage, "update_install_started");
  assert.equal(payload.events[3].stage, "update_install_failed");
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
    body: { period: "week", subjectId: "customer-retry" },
  });
  assert.equal(approve.status, 502);
  assert.equal(db.applications.get(created.applicationId).status, "pending");
  assert.equal(db.applications.get(created.applicationId).resource_state, "needs_reconcile");
});

test("one customer cannot retain multiple connections and physical retirement frees the slot", async () => {
  const db = new FakeD1();
  const provisioned = [];
  const deleted = [];
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    PILOT_LEASE_PUBLIC_KEY: publicKeyPem,
    DASHOU_ACTIVATION_KEY: ACTIVATION_KEY,
    DASHOU_CONTROL_PUBLIC_URL: "https://control.example",
    DEVICE_PROVISIONER: async (_env, application) => {
      provisioned.push(application.applicationId);
      return {
        tunnelId: `tunnel-${application.applicationId}`,
        tunnelToken: "cloudflare-tunnel-secret-for-device",
        hostname: `${application.applicationId}.warmbyte.studio`,
        publicBaseUrl: `https://${application.applicationId}.warmbyte.studio`,
      };
    },
    DEVICE_DEPROVISIONER: async (_env, device) => {
      deleted.push(device);
      return { ...device, deletedDnsRecords: 1 };
    },
  };
  const first = await createTestApplication(env, "J", "j", "搭手·晚风-2513", "D96A-5988");
  const second = await createTestApplication(env, "K", "k", "搭手·月牙-9165", "AD1E-33A1");
  const approveFirst = await request("POST", `/admin/applications/${first.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", subjectId: "customer-wanfeng" },
  });
  assert.equal(approveFirst.status, 200);
  const duplicate = await request("POST", `/admin/applications/${second.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", subjectId: "customer-wanfeng" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(provisioned.length, 1);

  await request("POST", `/admin/applications/${first.applicationId}/revoke`, { env, token: ADMIN_TOKEN, body: { reason: "暂停" } });
  const stillBlocked = await request("POST", `/admin/applications/${second.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", subjectId: "customer-wanfeng" },
  });
  assert.equal(stillBlocked.status, 409);

  const retired = await request("POST", `/admin/applications/${first.applicationId}/retire`, {
    env,
    token: ADMIN_TOKEN,
    body: { reason: "同一客户清理本地后改用新申请" },
  });
  assert.equal(retired.status, 200, JSON.stringify(await retired.clone().json()));
  assert.equal(db.applications.get(first.applicationId).resource_state, "deleted");
  assert.equal(deleted.length, 1);

  const replacement = await request("POST", `/admin/applications/${second.applicationId}/approve`, {
    env,
    token: ADMIN_TOKEN,
    body: { period: "month", subjectId: "customer-wanfeng" },
  });
  assert.equal(replacement.status, 200, JSON.stringify(await replacement.clone().json()));
  assert.equal(provisioned.length, 2);
});

test("global connection capacity guard fails closed before Cloudflare provisioning", async () => {
  const db = new FakeD1();
  let provisionCalls = 0;
  const env = {
    DB: db,
    PILOT_ADMIN_TOKEN: ADMIN_TOKEN,
    PILOT_LEASE_PUBLIC_KEY: publicKeyPem,
    DASHOU_ACTIVATION_KEY: ACTIVATION_KEY,
    DASHOU_CONTROL_PUBLIC_URL: "https://control.example",
    DASHOU_MAX_ACTIVE_RESOURCES: "1",
    DEVICE_PROVISIONER: async (_env, application) => {
      provisionCalls += 1;
      return { tunnelId: `tunnel-${application.applicationId}`, tunnelToken: "token-token-token-token", hostname: `${application.applicationId}.warmbyte.studio`, publicBaseUrl: `https://${application.applicationId}.warmbyte.studio` };
    },
  };
  const first = await createTestApplication(env, "L", "l", "搭手·青柠-1236", "3CC7-1313");
  const second = await createTestApplication(env, "M", "m", "搭手·晚风-2513", "D96A-5988");
  assert.equal((await request("POST", `/admin/applications/${first.applicationId}/approve`, { env, token: ADMIN_TOKEN, body: { period: "week", subjectId: "customer-one" } })).status, 200);
  const blocked = await request("POST", `/admin/applications/${second.applicationId}/approve`, { env, token: ADMIN_TOKEN, body: { period: "week", subjectId: "customer-two" } });
  assert.equal(blocked.status, 409);
  assert.equal(provisionCalls, 1);
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

test("Worker health exposes independent service compatibility metadata and build SHA", async () => {
  const env = { DB: new FakeD1(), PILOT_ADMIN_TOKEN: ADMIN_TOKEN, DASHOU_BUILD_SHA: "abc123" };
  const response = await request("GET", "/healthz", { env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    name: "dashou-pilot-control",
    serviceVersion: "1.0.1",
    apiVersion: 1,
    capabilities: [
      "adminReviewV1",
      "analyticsV1",
      "clientEventsV1",
      "resourceOwnershipV1",
      "retirementV1",
      "reversibleReviewV1",
    ],
    version: "1.0.1",
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

test("admin analytics exposes funnel and client failure coverage", async () => {
  const db = new FakeD1();
  const env = { DB: db, PILOT_ADMIN_TOKEN: ADMIN_TOKEN };
  const created = await request("POST", "/applications", {
    env,
    body: {
      applicationToken: "Z".repeat(43),
      deviceId: `dev_${"a".repeat(24)}`,
      deviceName: "分析设备",
      platform: "macos-arm64",
    },
  });
  const application = await created.json();
  const row = db.applications.get(application.applicationId);
  row.status = "activated";
  row.approved_at = row.created_at;
  row.activated_at = row.created_at;
  db.events.set(`${application.applicationId}.evt_first`, {
    application_id: application.applicationId,
    event_id: "evt_first",
    stage: "first_tool_call_success",
    outcome: "ok",
    error_code: null,
    client_unix_seconds: Math.floor(Date.parse(row.created_at) / 1_000),
    received_at: row.created_at,
  });
  db.events.set(`${application.applicationId}.evt_error`, {
    application_id: application.applicationId,
    event_id: "evt_error",
    stage: "runtime_start_failed",
    outcome: "error",
    error_code: "RUNTIME_START_FAILED",
    client_unix_seconds: Math.floor(Date.parse(row.created_at) / 1_000),
    received_at: row.created_at,
  });
  const unauthorized = await request("GET", "/admin/analytics", { env });
  assert.equal(unauthorized.status, 401);
  const response = await request("GET", "/admin/analytics", { env, token: ADMIN_TOKEN });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.funnel.find((step) => step.key === "first_use").count, 1);
  assert.equal(payload.errors[0].errorCode, "RUNTIME_START_FAILED");
});

async function createTestApplication(env, tokenCharacter, deviceCharacter, deviceNickname, deviceFingerprint) {
  const response = await request("POST", "/applications", {
    env,
    body: {
      applicationToken: tokenCharacter.repeat(43),
      deviceId: `dev_${deviceCharacter.repeat(24)}`,
      deviceName: deviceNickname,
      deviceNickname,
      deviceFingerprint,
      platform: "macos-aarch64",
    },
  });
  assert.equal(response.status, 201);
  return response.json();
}

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
  events = new Map();
  auditEvents = new Map();

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const snapshotRows = structuredClone(this.rows);
    const snapshotApplications = structuredClone(this.applications);
    const snapshotRateLimits = structuredClone(this.rateLimits);
    const snapshotEvents = structuredClone(this.events);
    const snapshotAuditEvents = structuredClone(this.auditEvents);
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.rows = snapshotRows;
      this.applications = snapshotApplications;
      this.rateLimits = snapshotRateLimits;
      this.events = snapshotEvents;
      this.auditEvents = snapshotAuditEvents;
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
      if (this.sql.includes("COUNT(*) AS count")) {
        return { count: [...this.db.applications.values()].filter((row) => ["provisioning", "active", "needs_reconcile", "deleting", "delete_failed"].includes(row.resource_state)).length };
      }
      if (this.sql.includes("WHERE subject_id = ?1") && this.sql.includes("application_id <> ?2")) {
        return [...this.db.applications.values()].find((row) =>
          row.subject_id === this.values[0]
          && row.application_id !== this.values[1]
          && ["provisioning", "active", "needs_reconcile", "deleting", "delete_failed"].includes(row.resource_state)
        ) ?? null;
      }
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
    if (this.sql.includes("FROM pilot_admin_audit_events")) {
      const rows = [...this.db.auditEvents.values()].filter((row) => row.application_id === this.values[0]);
      return { results: rows.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.audit_id.localeCompare(right.audit_id)) };
    }
    if (this.sql.includes("FROM pilot_client_events")) {
      const rows = [...this.db.events.values()].filter((row) => !this.sql.includes("WHERE application_id") || row.application_id === this.values[0]);
      return { results: rows.sort((left, right) => left.received_at.localeCompare(right.received_at) || left.client_unix_seconds - right.client_unix_seconds) };
    }
    if (this.sql.includes("FROM pilot_applications")) {
      const rows = [...this.db.applications.values()];
      return { results: this.sql.includes("WHERE status = ?1") ? rows.filter((row) => row.status === this.values[0]) : rows };
    }
    return { results: [...this.db.rows.values()] };
  }

  async run() {
    if (this.sql === "DELETE FROM pilot_client_events") {
      const changes = this.db.events.size;
      this.db.events.clear();
      return result(changes);
    }
    if (this.sql === "DELETE FROM pilot_admin_audit_events") {
      const changes = this.db.auditEvents.size;
      this.db.auditEvents.clear();
      return result(changes);
    }
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
    if (this.sql.startsWith("INSERT OR IGNORE INTO pilot_client_events")) {
      const [applicationId, eventId, stage, outcome, errorCode, appVersion, clientUnixSeconds, receivedAt, deviceNickname, deviceFingerprint] = this.values;
      const key = `${applicationId}.${eventId}`;
      if (this.db.events.has(key)) return result(0);
      this.db.events.set(key, {
        application_id: applicationId,
        event_id: eventId,
        stage,
        outcome,
        error_code: errorCode,
        app_version: appVersion,
        client_unix_seconds: clientUnixSeconds,
        received_at: receivedAt,
        device_nickname: deviceNickname,
        device_fingerprint: deviceFingerprint,
      });
      return result(1);
    }
    if (this.sql.includes("VALUES (?1, ?2, ?3, 'note_added'")) {
      const [auditId, applicationId, actor, note, requestId, createdAt] = this.values;
      this.db.auditEvents.set(auditId, { audit_id: auditId, application_id: applicationId, actor, action: "note_added", from_status: null, to_status: null, from_period: null, to_period: null, reason: null, note, request_id: requestId, created_at: createdAt });
      return result(1);
    }
    if (this.sql.startsWith("INSERT INTO pilot_admin_audit_events")) {
      const [auditId, applicationId, actor, action, fromStatus, toStatus, fromPeriod, toPeriod, reason, note, requestId, createdAt] = this.values;
      this.db.auditEvents.set(auditId, { audit_id: auditId, application_id: applicationId, actor, action, from_status: fromStatus, to_status: toStatus, from_period: fromPeriod, to_period: toPeriod, reason, note, request_id: requestId, created_at: createdAt });
      return result(1);
    }
    if (this.sql.startsWith("INSERT INTO pilot_applications")) {
      const [applicationId, applicationTokenHash, deviceId, deviceName, deviceNickname, deviceFingerprint, platform, contact, createdAt] = this.values;
      this.db.applications.set(applicationId, {
        application_id: applicationId,
        application_token_hash: applicationTokenHash,
        device_id: deviceId,
        device_name: deviceName,
        device_nickname: deviceNickname,
        device_fingerprint: deviceFingerprint,
        nickname: null,
        profile_note: null,
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
        revoked_from_status: null,
        provisioning_started_at: null,
        subject_id: null,
        resource_state: null,
        resource_error: null,
        deprovisioned_at: null,
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
    if (this.sql.startsWith("UPDATE pilot_accounts SET expires_at = ?1")) {
      const [expiresAt, accountId] = this.values;
      const row = this.db.rows.get(accountId);
      if (!row) return result(0);
      row.expires_at = expiresAt;
      return result(1);
    }
    if (this.sql.startsWith("UPDATE pilot_accounts SET enabled = 1, revoked_at = NULL")) {
      const [accountId] = this.values;
      const row = this.db.rows.get(accountId);
      if (!row) return result(0);
      row.enabled = 1;
      row.revoked_at = null;
      return result(1);
    }
    if (this.sql.startsWith("UPDATE pilot_accounts SET enabled = 1")) {
      const [expiresAt, accountId] = this.values;
      const row = this.db.rows.get(accountId);
      if (!row) return result(0);
      row.enabled = 1;
      row.expires_at = expiresAt;
      row.revoked_at = null;
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
      const [subjectId, startedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "pending") return result(0);
      row.status = "provisioning";
      row.subject_id = subjectId;
      row.resource_state = "provisioning";
      row.resource_error = null;
      row.provisioning_started_at = startedAt;
      row.updated_at = startedAt;
      return result(1);
    }
    if (this.sql.includes("SET provisioning_started_at") && this.sql.includes("status = 'provisioning'")) {
      const [subjectId, startedAt, applicationId, expectedStartedAt] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "provisioning" || row.provisioning_started_at !== expectedStartedAt) return result(0);
      row.subject_id = subjectId;
      row.resource_state = "provisioning";
      row.resource_error = null;
      row.provisioning_started_at = startedAt;
      row.updated_at = startedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'pending'") && !this.sql.includes("rejected_at = NULL")) {
      const [resourceError, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "provisioning") return result(0);
      row.status = "pending";
      row.resource_state = "needs_reconcile";
      row.resource_error = resourceError;
      row.provisioning_started_at = null;
      row.updated_at = updatedAt;
      return result(1);
    }
    if (this.sql.includes("SET status = 'approved'")) {
      const [period, accountId, tunnelId, hostname, ciphertext, approvedAt, expiresAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "provisioning") return result(0);
      Object.assign(row, { status: "approved", resource_state: "active", resource_error: null, period, account_id: accountId, tunnel_id: tunnelId, hostname, activation_ciphertext: ciphertext, approved_at: approvedAt, expires_at: expiresAt, updated_at: approvedAt });
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
    if (this.sql.includes("SET status = 'pending'") && this.sql.includes("rejected_at = NULL")) {
      const [updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "rejected") return result(0);
      Object.assign(row, { status: "pending", rejected_at: null, rejection_reason: null, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET period = ?1, expires_at = ?2, activation_ciphertext = ?3")) {
      const [period, expiresAt, ciphertext, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "approved") return result(0);
      Object.assign(row, { period, expires_at: expiresAt, activation_ciphertext: ciphertext, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET expires_at = ?1, updated_at = ?2") && this.sql.includes("status = 'activated'")) {
      const [expiresAt, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "activated") return result(0);
      Object.assign(row, { expires_at: expiresAt, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET status = 'revoked'") && this.sql.includes("resource_state = 'deleting'")) {
      const [revokedAt, revokedFromStatus, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row) return result(0);
      Object.assign(row, {
        status: "revoked",
        revoked_at: row.revoked_at ?? revokedAt,
        revoked_from_status: row.revoked_from_status ?? revokedFromStatus,
        resource_state: "deleting",
        resource_error: null,
        updated_at: revokedAt,
      });
      return result(1);
    }
    if (this.sql.includes("resource_state = 'deleted'")) {
      const [deprovisionedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.resource_state !== "deleting") return result(0);
      Object.assign(row, { resource_state: "deleted", resource_error: null, deprovisioned_at: deprovisionedAt, updated_at: deprovisionedAt });
      return result(1);
    }
    if (this.sql.includes("resource_state = 'delete_failed'")) {
      const [resourceError, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.resource_state !== "deleting") return result(0);
      Object.assign(row, { resource_state: "delete_failed", resource_error: resourceError, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET status = 'revoked'")) {
      const [revokedAt, revokedFromStatus, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row) return result(0);
      Object.assign(row, { status: "revoked", revoked_at: revokedAt, revoked_from_status: revokedFromStatus, updated_at: revokedAt });
      return result(1);
    }
    if (this.sql.includes("SET subject_id = ?1, updated_at = ?2")) {
      const [subjectId, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row) return result(0);
      Object.assign(row, { subject_id: subjectId, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET status = ?1, revoked_at = NULL")) {
      const [status, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row || row.status !== "revoked") return result(0);
      Object.assign(row, { status, revoked_at: null, revoked_from_status: null, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET period = NULL, expires_at = ?1")) {
      const [expiresAt, ciphertext, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row) return result(0);
      Object.assign(row, { period: null, expires_at: expiresAt, activation_ciphertext: ciphertext, updated_at: updatedAt });
      return result(1);
    }
    if (this.sql.includes("SET nickname = ?1, profile_note = ?2")) {
      const [nickname, profileNote, updatedAt, applicationId] = this.values;
      const row = this.db.applications.get(applicationId);
      if (!row) return result(0);
      Object.assign(row, { nickname, profile_note: profileNote, updated_at: updatedAt });
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
