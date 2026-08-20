import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markConnectionMilestone } from "./connection-milestones.js";

test("connection milestones contain only a timestamp and never block the runtime", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dashou-connection-"));
  try {
    assert.equal(markConnectionMilestone(stateDir, "oauth-completed"), true);
    const value = readFileSync(join(stateDir, "connection-oauth-completed"), "utf8");
    assert.match(value, /^\d+\n$/);
    assert.equal(value.includes("token"), false);
    assert.equal(markConnectionMilestone("\0invalid", "first-mcp-session"), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
