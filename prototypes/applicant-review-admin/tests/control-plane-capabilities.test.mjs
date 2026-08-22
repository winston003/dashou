import assert from "node:assert/strict";
import test from "node:test";
import {
  hasControlPlaneCapability,
  missingCapabilityMessage,
} from "../src/control-plane-capabilities.js";

test("detects explicitly advertised control-plane capabilities", () => {
  assert.equal(hasControlPlaneCapability({ capabilities: ["analyticsV1"] }, "analyticsV1"), true);
  assert.equal(hasControlPlaneCapability({ capabilities: [] }, "analyticsV1"), false);
  assert.equal(hasControlPlaneCapability({ version: "legacy" }, "analyticsV1"), false);
});

test("explains compatibility without leaking a raw 404", () => {
  const message = missingCapabilityMessage({ version: "0.1.3-rc.16" }, "analyticsV1", "申请分析");
  assert.match(message, /0\.1\.3-rc\.16/);
  assert.match(message, /无需升级客户端或 Admin 面板/);
  assert.doesNotMatch(message, /Not found/);
});
