import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DashouConfig } from "./dashou-config.js";
import { dashouConfigDir } from "./dashou-config.js";

type PilotApplicationRecord = {
  controlBaseUrl?: string;
  applicationToken?: string;
  applicationId?: string;
};

type TelemetryOptions = {
  configDirectory?: string;
  fetchImpl?: typeof fetch;
  appVersion?: string;
};

export async function recordFirstMcpUse(config: DashouConfig, options: TelemetryOptions = {}): Promise<boolean> {
  const marker = join(config.stateDir, "first-mcp-use.json");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(marker, JSON.stringify({ claimedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    return false;
  }

  try {
    const application = await readApplicationRecord(options.configDirectory ?? dashouConfigDir());
    if (!application.applicationId || !application.applicationToken || !application.controlBaseUrl) throw new Error("application record is incomplete");
    const controlUrl = new URL(application.controlBaseUrl);
    const localControl = ["localhost", "127.0.0.1", "::1"].includes(controlUrl.hostname);
    if (controlUrl.protocol !== "https:" && !(controlUrl.protocol === "http:" && localControl)) throw new Error("telemetry control plane must use HTTPS");
    const endpoint = new URL(`/applications/${encodeURIComponent(application.applicationId)}/events`, controlUrl).toString();
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${application.applicationToken}`,
      },
      body: JSON.stringify({
        events: [{
          eventId: `evt_${randomEventId()}`,
          stage: "first_mcp_use",
          outcome: "ok",
          appVersion: options.appVersion ?? "runtime",
          unixSeconds: Math.floor(Date.now() / 1_000),
        }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`telemetry returned HTTP ${response.status}`);
    return true;
  } catch {
    await rm(marker, { force: true }).catch(() => undefined);
    return false;
  }
}

async function readApplicationRecord(configDirectory: string): Promise<PilotApplicationRecord> {
  const text = await readFile(join(configDirectory, "application.json"), "utf8");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.controlBaseUrl === "string" ? { controlBaseUrl: record.controlBaseUrl } : {}),
    ...(typeof record.applicationToken === "string" ? { applicationToken: record.applicationToken } : {}),
    ...(typeof record.applicationId === "string" ? { applicationId: record.applicationId } : {}),
  };
}

function randomEventId(): string {
  return randomUUID().replaceAll("-", "");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
