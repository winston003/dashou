import assert from "node:assert/strict";
import test from "node:test";
import { runtimeContractReport, runtimeEnvironment } from "./dashou-runtime-contract.js";

test("runtime contract accepts the supported Node family and aligned PATH", () => {
  const report = runtimeContractReport({ PATH: process.env.PATH ?? "" }, process.execPath, process.version, process.versions.modules);
  assert.equal(report.ok, true);
  assert.equal(report.pathNodeExecutable, process.execPath);
  assert.ok(report.pathNpmExecutable);
  assert.ok(report.pathNpxExecutable);
});

test("runtime contract reports a mismatched daemon runtime", () => {
  const report = runtimeContractReport({ PATH: "/definitely-missing" }, "/tmp/node-other-runtime/bin/node", "v20.0.0", "115");
  assert.equal(report.ok, false);
  assert.match(report.issues.join("\n"), /outside|does not contain/);
  assert.match(report.issues.join("\n"), /npx/);
});

test("runtime environment puts the daemon Node directory first for child commands", () => {
  const environment = runtimeEnvironment({ PATH: "/other/bin:/usr/bin" }, "/opt/dashou-node/bin/node");
  assert.equal(environment.PATH, "/opt/dashou-node/bin:/other/bin:/usr/bin");
});
