import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DashouConfig } from "./dashou-config.js";
import { recordFirstMcpUse } from "./dashou-pilot-telemetry.js";

test("first MCP use telemetry is sent once without including payload data", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashou-telemetry-"));
  const stateDir = join(root, "state");
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "application.json"), JSON.stringify({
    controlBaseUrl: "https://control.example",
    applicationToken: "application-secret",
    applicationId: "req_abcdefghijklmnop",
  }));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = { stateDir, oauth: { pilotRemote: undefined } } as unknown as DashouConfig;
  assert.equal(await recordFirstMcpUse(config, { configDirectory, fetchImpl, appVersion: "test" }), true);
  assert.equal(await recordFirstMcpUse(config, { configDirectory, fetchImpl, appVersion: "test" }), false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/applications\/req_abcdefghijklmnop\/events$/);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(body.events[0].stage, "first_mcp_use");
  assert.equal(body.events[0].appVersion, "test");
  assert.equal("applicationToken" in body, false);
  assert.match(await readFile(join(stateDir, "first-mcp-use.json"), "utf8"), /claimedAt/);
  await rm(root, { recursive: true, force: true });
});
