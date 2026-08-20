import assert from "node:assert/strict";
import test from "node:test";
import { runtimeContractReport, runtimeEnvironment, userCommandEnvironment } from "./dashou-runtime-contract.js";

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

test("project command environment excludes service and user credentials", () => {
  const environment = userCommandEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/example",
    LANG: "zh_CN.UTF-8",
    DASHOU_PILOT_POLICY_TOKEN: "pilot-secret",
    TUNNEL_TOKEN: "tunnel-secret",
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    HTTP_PROXY: "http://user:password@proxy.example",
  }, "/opt/dashou-node/bin/node");

  assert.equal(environment.PATH, "/opt/dashou-node/bin:/usr/bin");
  assert.equal(environment.HOME, "/Users/example");
  assert.equal(environment.LANG, "zh_CN.UTF-8");
  assert.equal(environment.DASHOU_PILOT_POLICY_TOKEN, undefined);
  assert.equal(environment.TUNNEL_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.HTTP_PROXY, undefined);
});
