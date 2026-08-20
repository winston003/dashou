import assert from "node:assert/strict";
import test from "node:test";
import { defaultCopy } from "../src/copy";
import { applicationStatusLabel, chatgptConnectionLabel, platformLabel, troubleshootingNeedsAttention, troubleshootingStatus, troubleshootingStep, troubleshootingStepLabel } from "../src/diagnostics";
import type { DesktopSnapshot } from "../src/types";

const snapshot = (overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot => ({
  version: "0.1.3-rc.14",
  deviceNickname: "搭手·青柠-4827",
  deviceFingerprint: "7F3A-91C2",
  platform: "windows-x86_64",
  lastCheckedUnixSeconds: 1_786_838_400,
  configured: true,
  allowedRoots: ["/work/project"],
  runtimePhase: "ready",
  localHealth: true,
  publicHealth: true,
  recoveryAttempts: 0,
  launchAtLogin: true,
  notifyWhenReady: false,
  allowProjectCommands: false,
  contentVersion: "built-in",
  uiSource: "built-in",
  ...overrides,
});

test("troubleshooting card maps application progress to a concrete step", () => {
  assert.equal(troubleshootingStep({ status: "pending" }, snapshot()), "waiting_confirmation");
  assert.equal(troubleshootingStepLabel("waiting_confirmation", defaultCopy), "等待确认");
  assert.equal(troubleshootingStatus({ status: "pending" }, snapshot(), defaultCopy), "正在准备");
  assert.equal(troubleshootingStep({ status: "activated" }, snapshot()), "ready");
});

test("another local connection takes priority over a healthy-looking snapshot", () => {
  const value = snapshot({ error: { code: "OTHER_PROCESS", retryable: true } });
  assert.equal(troubleshootingStep({ status: "activated" }, value), "other_connection");
  assert.equal(troubleshootingStepLabel("other_connection", defaultCopy), "另一套连接正在使用");
});

test("diagnostic card uses a friendly platform name without exposing a path", () => {
  assert.equal(platformLabel("macos-aarch64"), "macOS Apple 芯片");
  assert.equal(platformLabel("windows-x86_64"), "Windows");
  assert.equal(platformLabel("windows-x86_64").includes("/"), false);
});

test("application status stays human-readable", () => {
  assert.equal(applicationStatusLabel("not_applied", defaultCopy), "还没有开始");
  assert.equal(applicationStatusLabel("approved", defaultCopy), "已经准备好");
  assert.equal(applicationStatusLabel("revoked", defaultCopy), "已结束");
});

test("support card distinguishes local readiness from ChatGPT progress", () => {
  assert.equal(chatgptConnectionLabel("not_started", defaultCopy), "还未开始");
  assert.equal(chatgptConnectionLabel("authorization_requested", defaultCopy), "等待授权密码");
  assert.equal(chatgptConnectionLabel("connected", defaultCopy), "已经连接");
  assert.equal(chatgptConnectionLabel("first_task_completed", defaultCopy), "首次任务成功");
});

test("troubleshooting stays folded unless the user needs to act", () => {
  assert.equal(troubleshootingNeedsAttention({ status: "activated" }, snapshot()), false);
  assert.equal(troubleshootingNeedsAttention({ status: "pending" }, snapshot({ configured: false, runtimePhase: "needs_setup" })), false);
  assert.equal(troubleshootingNeedsAttention({ status: "activated" }, snapshot({ runtimePhase: "blocked" })), true);
  assert.equal(troubleshootingNeedsAttention({ status: "rejected" }, snapshot()), true);
});
