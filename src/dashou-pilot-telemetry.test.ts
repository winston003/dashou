import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DashouConfig } from "./dashou-config.js";
import {
  flushPendingPilotTelemetry,
  queueFirstToolCallFailure,
  queueFirstToolCallSuccess,
} from "./dashou-pilot-telemetry.js";

test("first successful tool call is queued once and marked sent without payload data", async () => {
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
  const config = pilotConfig(stateDir);
  assert.equal(await queueFirstToolCallSuccess(config, { configDirectory, fetchImpl, appVersion: "test", autoFlush: false }), true);
  assert.equal(await queueFirstToolCallSuccess(config, { configDirectory, fetchImpl, appVersion: "test", autoFlush: false }), false);
  assert.equal(await flushPendingPilotTelemetry(config, { configDirectory, fetchImpl }), 1);
  assert.equal(await queueFirstToolCallSuccess(config, { configDirectory, fetchImpl, appVersion: "test", autoFlush: false }), false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/applications\/req_abcdefghijklmnop\/events$/);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(body.events[0].stage, "first_tool_call_success");
  assert.equal(body.events[0].appVersion, "test");
  assert.equal("applicationToken" in body, false);
  assert.match(await readFile(join(stateDir, "pilot-telemetry", "first_tool_call_success.sent.json"), "utf8"), /eventId/);
  await rm(root, { recursive: true, force: true });
});

test("failed delivery remains pending and retries with the same event id", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashou-telemetry-retry-"));
  const stateDir = join(root, "state");
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "application.json"), JSON.stringify({
    controlBaseUrl: "https://control.example",
    applicationToken: "application-secret",
    applicationId: "req_abcdefghijklmnop",
  }));
  const eventIds: string[] = [];
  let succeeds = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    eventIds.push(JSON.parse(String(init?.body)).events[0].eventId);
    return new Response(null, { status: succeeds ? 200 : 503 });
  };
  const config = pilotConfig(stateDir);
  assert.equal(await queueFirstToolCallFailure(config, "PROJECT_NOT_OPEN", { configDirectory, fetchImpl, appVersion: "test", autoFlush: false }), true);
  assert.equal(await flushPendingPilotTelemetry(config, { configDirectory, fetchImpl }), 0);
  assert.match(await readFile(join(stateDir, "pilot-telemetry", "first_tool_call_failure.pending.json"), "utf8"), /PROJECT_NOT_OPEN/);
  succeeds = true;
  assert.equal(await flushPendingPilotTelemetry(config, { configDirectory, fetchImpl }), 1);
  assert.equal(eventIds.length, 2);
  assert.equal(eventIds[0], eventIds[1]);
  await rm(root, { recursive: true, force: true });
});

test("telemetry storage failures never fail the user tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashou-telemetry-storage-"));
  const invalidStateDir = join(root, "state-file");
  await writeFile(invalidStateDir, "not a directory");
  assert.equal(await queueFirstToolCallSuccess(pilotConfig(invalidStateDir), { autoFlush: false }), false);
  await rm(root, { recursive: true, force: true });
});

function pilotConfig(stateDir: string): DashouConfig {
  return {
    stateDir,
    oauth: { pilotRemote: { url: "https://control.example/pilot-policy" } },
  } as unknown as DashouConfig;
}
