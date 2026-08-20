import assert from "node:assert/strict";
import test from "node:test";
import { accessIsReady, accessIsWaiting, canCopyPassword, canRemoveRoot, chatgptGuideStep, initialState, phaseLabel, reducer, shouldPollAccess } from "../src/state";
import type { DesktopSnapshot } from "../src/types";

test("snapshot hydrates roots and preferences without secrets", () => {
  const next = reducer(initialState, {
    type: "snapshot",
    snapshot: {
      version: "0.1.3-rc.13",
      deviceNickname: "搭手·青柠-4827",
      deviceFingerprint: "7F3A-91C2",
      platform: "macos-aarch64",
      lastCheckedUnixSeconds: 1_786_838_400,
      configured: true,
      allowedRoots: ["/work/one", "/work/two"],
      runtimePhase: "ready",
      localHealth: true,
      publicHealth: true,
      mcpUrl: "https://example.test/mcp",
      recoveryAttempts: 0,
      launchAtLogin: true,
      notifyWhenReady: false,
      contentVersion: "built-in",
      uiSource: "built-in",
    },
  });
  assert.deepEqual(next.selectedRoots, ["/work/one", "/work/two"]);
  assert.equal(next.rootsDirty, false);
  assert.equal(next.preferences.launchAtLogin, true);
  assert.equal("password" in next.snapshot!, false);
});

test("root editing stays unique and never mutates the previous state", () => {
  const next = reducer(initialState, { type: "roots", roots: ["/a", "/a", "", "/b"] });
  assert.deepEqual(next.selectedRoots, ["/a", "/b"]);
  assert.equal(next.rootsDirty, true);
  assert.deepEqual(initialState.selectedRoots, []);
});

test("background snapshots do not overwrite folders being edited", () => {
  const hydrated = reducer(initialState, {
    type: "snapshot",
    snapshot: {
      version: "0.1.3-rc.13",
      deviceNickname: "搭手·青柠-4827",
      deviceFingerprint: "7F3A-91C2",
      platform: "macos-aarch64",
      lastCheckedUnixSeconds: 1_786_838_400,
      configured: true,
      allowedRoots: ["/work/one"],
      runtimePhase: "ready",
      localHealth: true,
      publicHealth: true,
      recoveryAttempts: 0,
      launchAtLogin: true,
      notifyWhenReady: false,
      contentVersion: "built-in",
      uiSource: "built-in",
    },
  });
  const editing = reducer(hydrated, { type: "roots", roots: ["/work/one", "/work/two"] });
  const refreshed = reducer(editing, {
    type: "snapshot",
    snapshot: { ...editing.snapshot!, runtimePhase: "connecting", allowedRoots: ["/work/one"] },
  });
  assert.deepEqual(refreshed.selectedRoots, ["/work/one", "/work/two"]);
  assert.equal(refreshed.rootsDirty, true);
  const saved = reducer(refreshed, {
    type: "snapshot",
    snapshot: { ...refreshed.snapshot!, allowedRoots: ["/work/one", "/work/two"], configured: true },
    syncRoots: true,
  });
  assert.deepEqual(saved.selectedRoots, ["/work/one", "/work/two"]);
  assert.equal(saved.rootsDirty, false);
});

test("runtime phases map to user-facing status groups", () => {
  assert.equal(phaseLabel("starting"), "preparing");
  assert.equal(phaseLabel("connecting"), "connecting");
  assert.equal(phaseLabel("recovering"), "recovering");
  assert.equal(phaseLabel("blocked"), "blocked");
  assert.equal(phaseLabel("stopped"), "stopped");
});

test("access states distinguish waiting, ready, and rejected flows", () => {
  assert.equal(accessIsWaiting({ status: "pending" }), true);
  assert.equal(accessIsWaiting({ status: "provisioning" }), true);
  assert.equal(accessIsWaiting({ status: "rejected" }), false);
  assert.equal(accessIsReady(null, { status: "approved" }), true);
  assert.equal(accessIsReady(null, { status: "active" }), true);
  assert.equal(accessIsReady(null, { status: "pending" }), false);
  assert.equal(accessIsReady({ configured: true } as DesktopSnapshot, { status: "not_applied" }), true);
});

test("access polling stops after activation or a terminal result", () => {
  assert.equal(shouldPollAccess({ status: "not_applied" }), true);
  assert.equal(shouldPollAccess({ status: "pending" }), true);
  assert.equal(shouldPollAccess({ status: "provisioning" }), true);
  assert.equal(shouldPollAccess({ status: "approved" }), true);
  assert.equal(shouldPollAccess({ status: "activated" }), false);
  assert.equal(shouldPollAccess({ status: "rejected" }), false);
  assert.equal(shouldPollAccess({ status: "expired" }), false);
});

test("the last selected folder cannot be removed", () => {
  assert.equal(canRemoveRoot([]), false);
  assert.equal(canRemoveRoot(["/work/one"]), false);
  assert.equal(canRemoveRoot(["/work/one", "/work/two"]), true);
});

test("password remains available while the local service is healthy during recovery", () => {
  assert.equal(canCopyPassword({ configured: true, localHealth: true, runtimePhase: "recovering" } as DesktopSnapshot), true);
  assert.equal(canCopyPassword({ configured: true, localHealth: false, runtimePhase: "recovering" } as DesktopSnapshot), false);
  assert.equal(canCopyPassword({ configured: true, localHealth: true, runtimePhase: "stopped" } as DesktopSnapshot), false);
});

test("ChatGPT onboarding advances only on real connection milestones", () => {
  assert.equal(chatgptGuideStep("not_started"), 1);
  assert.equal(chatgptGuideStep("setup_opened"), 2);
  assert.equal(chatgptGuideStep("authorization_requested"), 3);
  assert.equal(chatgptGuideStep("oauth_completed"), 3);
  assert.equal(chatgptGuideStep("connected"), 3);
  assert.equal(chatgptGuideStep("first_task_completed"), 3);
});

test("a healthy snapshot clears a stale restart error", () => {
  const withError = reducer(initialState, { type: "error", value: "搭手发现另一套连接正在使用这台电脑" });
  const healthy = reducer(withError, {
    type: "snapshot",
    snapshot: {
      version: "0.1.3-rc.13",
      deviceNickname: "搭手·青柠-4827",
      deviceFingerprint: "7F3A-91C2",
      platform: "macos-aarch64",
      lastCheckedUnixSeconds: 1_786_838_400,
      configured: true,
      allowedRoots: ["/work/one"],
      runtimePhase: "ready",
      localHealth: true,
      publicHealth: true,
      recoveryAttempts: 0,
      launchAtLogin: true,
      notifyWhenReady: false,
      contentVersion: "built-in",
      uiSource: "built-in",
    },
  });
  assert.equal(healthy.error, null);
});

test("an available update is kept for review before installation", () => {
  const update = {
    currentVersion: "0.1.3-rc.13",
    version: "0.1.3-rc.13",
    body: "连接更稳定，首次使用更简单。",
  };
  const found = reducer(initialState, { type: "availableUpdate", value: update });
  assert.deepEqual(found.availableUpdate, update);
  assert.equal(reducer(found, { type: "availableUpdate", value: null }).availableUpdate, null);
});
