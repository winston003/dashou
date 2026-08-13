import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireServeInstanceLock, isDashouServeCommand } from "./dashou-single-instance.js";

test("serve command identity recognizes the Dashou daemon", () => {
  assert.equal(isDashouServeCommand("/Users/whilewon/.local/bin/node dist/dashou-cli.js serve"), true);
  assert.equal(isDashouServeCommand("/Users/whilewon/.local/bin/node dist/dashou-cli.js doctor"), false);
  assert.equal(isDashouServeCommand("/usr/bin/corespeechd"), false);
});

test("serve instance lock rejects a duplicate and can be released", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-single-instance-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const first = acquireServeInstanceLock(stateDir, process.pid);
  assert.throws(
    () => acquireServeInstanceLock(stateDir, process.pid),
    /Dashou 已经在运行/u,
  );
  first.release();

  const second = acquireServeInstanceLock(stateDir, process.pid);
  second.release();
});

test("serve instance lock replaces a stale owner", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "dashou-single-instance-stale-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const lockPath = join(stateDir, "serve.lock");
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "pid"), "99999999\n", { mode: 0o600 });

  const lock = acquireServeInstanceLock(stateDir, process.pid);
  assert.equal(lock.path, lockPath);
  lock.release();
});
