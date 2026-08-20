import assert from "node:assert/strict";
import test from "node:test";
import type { VNode } from "preact";
import { SettingsView } from "../src/components/SettingsView";
import { defaultCopy } from "../src/copy";

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (!node || typeof node !== "object") return "";
  return textContent((node as VNode).props?.children);
}

test("settings shows release notes before the user installs an update", () => {
  const view = SettingsView({
    copy: defaultCopy,
    snapshot: null,
    access: { status: "not_applied" },
    version: "0.1.3-rc.13",
    preferences: { launchAtLogin: true, notifyWhenReady: false },
    busy: null,
    availableUpdate: {
      currentVersion: "0.1.3-rc.13",
      version: "0.1.3-rc.13",
      body: "连接更稳定，首次使用更简单。",
    },
    onPreference: () => undefined,
    onCheckUpdate: () => undefined,
    onInstallUpdate: () => undefined,
    onDismissUpdate: () => undefined,
    onCopyDiagnostics: () => undefined,
    onCopyAddress: () => undefined,
    onImportInvite: () => undefined,
    onConfigureAgain: () => undefined,
  });

  const text = textContent(view);
  assert.match(text, /可更新到\s+0\.1\.3-rc\.13/);
  assert.match(text, /连接更稳定，首次使用更简单/);
  assert.match(text, /稍后再说/);
  assert.match(text, /更新并重新打开/);
  assert.doesNotMatch(text, /检查更新/);
});

test("the trust copy states the real command permission boundary", () => {
  assert.match(defaultCopy.trustBody, /读取和修改文件只会在你选择的文件夹/);
  assert.match(defaultCopy.trustBody, /电脑上你的账户权限/);
  assert.match(defaultCopy.trustBody, /用起来更安心/);
});
