import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DashouConfig } from "./dashou-config.js";
import { dashouConfigDir } from "./dashou-config.js";

type PilotApplicationRecord = {
  controlBaseUrl?: string;
  applicationToken?: string;
  applicationId?: string;
};

type PilotTelemetryStage =
  | "first_mcp_connection"
  | "first_tool_call_attempt"
  | "first_tool_call_success"
  | "first_tool_call_failure";

type PendingPilotEvent = {
  eventId: string;
  stage: PilotTelemetryStage;
  outcome: "ok" | "error";
  appVersion: string;
  unixSeconds: number;
  errorCode?: string;
};

type TelemetryOptions = {
  configDirectory?: string;
  fetchImpl?: typeof fetch;
  appVersion?: string;
  autoFlush?: boolean;
};

const TELEMETRY_DIRECTORY = "pilot-telemetry";
const activeFlushes = new Map<string, Promise<boolean>>();

export async function queueFirstMcpConnection(config: DashouConfig, options: TelemetryOptions = {}): Promise<boolean> {
  return queueFirstEvent(config, "first_mcp_connection", "ok", undefined, options);
}

export async function queueFirstToolCallAttempt(config: DashouConfig, options: TelemetryOptions = {}): Promise<boolean> {
  return queueFirstEvent(config, "first_tool_call_attempt", "ok", undefined, options);
}

export async function queueFirstToolCallSuccess(config: DashouConfig, options: TelemetryOptions = {}): Promise<boolean> {
  return queueFirstEvent(config, "first_tool_call_success", "ok", undefined, options);
}

export async function queueFirstToolCallFailure(
  config: DashouConfig,
  errorCode: string,
  options: TelemetryOptions = {},
): Promise<boolean> {
  return queueFirstEvent(config, "first_tool_call_failure", "error", safeErrorCode(errorCode), options);
}

export async function flushPendingPilotTelemetry(config: DashouConfig, options: TelemetryOptions = {}): Promise<number> {
  if (!config.oauth.pilotRemote) return 0;
  const directory = telemetryDirectory(config);
  const entries = await readdir(directory).catch(() => []);
  const pendingPaths = entries
    .filter((entry) => entry.endsWith(".pending.json"))
    .map((entry) => join(directory, entry));
  const results = await Promise.all(pendingPaths.map((path) => flushPendingEvent(config, path, options)));
  return results.filter(Boolean).length;
}

async function queueFirstEvent(
  config: DashouConfig,
  stage: PilotTelemetryStage,
  outcome: "ok" | "error",
  errorCode: string | undefined,
  options: TelemetryOptions,
): Promise<boolean> {
  try {
    return await persistFirstEvent(config, stage, outcome, errorCode, options);
  } catch {
    return false;
  }
}

async function persistFirstEvent(
  config: DashouConfig,
  stage: PilotTelemetryStage,
  outcome: "ok" | "error",
  errorCode: string | undefined,
  options: TelemetryOptions,
): Promise<boolean> {
  if (!config.oauth.pilotRemote) return false;
  const directory = telemetryDirectory(config);
  const pendingPath = join(directory, `${stage}.pending.json`);
  const sentPath = join(directory, `${stage}.sent.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fileExists(sentPath)) {
    await rm(pendingPath, { force: true }).catch(() => undefined);
    return false;
  }

  const event: PendingPilotEvent = {
    eventId: `evt_${randomEventId()}`,
    stage,
    outcome,
    appVersion: options.appVersion ?? "runtime",
    unixSeconds: Math.floor(Date.now() / 1_000),
    ...(errorCode ? { errorCode } : {}),
  };
  let claimed = true;
  try {
    await writeFile(pendingPath, `${JSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) return false;
    claimed = false;
  }

  if (options.autoFlush !== false) void flushPendingEvent(config, pendingPath, options);
  return claimed;
}

async function flushPendingEvent(config: DashouConfig, pendingPath: string, options: TelemetryOptions): Promise<boolean> {
  const existing = activeFlushes.get(pendingPath);
  if (existing) return existing;
  const flush = deliverPendingEvent(config, pendingPath, options).finally(() => {
    activeFlushes.delete(pendingPath);
  });
  activeFlushes.set(pendingPath, flush);
  return flush;
}

async function deliverPendingEvent(config: DashouConfig, pendingPath: string, options: TelemetryOptions): Promise<boolean> {
  try {
    const event = await readPendingEvent(pendingPath);
    if (!event) return false;
    const sentPath = pendingPath.replace(/\.pending\.json$/, ".sent.json");
    if (await fileExists(sentPath)) {
      await rm(pendingPath, { force: true });
      return false;
    }
    const application = await readApplicationRecord(options.configDirectory ?? dashouConfigDir());
    if (!application.applicationId || !application.applicationToken || !application.controlBaseUrl) return false;
    const controlUrl = new URL(application.controlBaseUrl);
    const localControl = ["localhost", "127.0.0.1", "::1"].includes(controlUrl.hostname);
    if (controlUrl.protocol !== "https:" && !(controlUrl.protocol === "http:" && localControl)) return false;
    const endpoint = new URL(`/applications/${encodeURIComponent(application.applicationId)}/events`, controlUrl).toString();
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${application.applicationToken}`,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    await writeFile(sentPath, `${JSON.stringify({ eventId: event.eventId, sentAt: new Date().toISOString() })}\n`, {
      flag: "wx",
      mode: 0o600,
    }).catch((error) => {
      if (!isAlreadyExists(error)) throw error;
    });
    await rm(pendingPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function readPendingEvent(path: string): Promise<PendingPilotEvent | null> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== "string"
    || typeof event.stage !== "string"
    || !["first_mcp_connection", "first_tool_call_attempt", "first_tool_call_success", "first_tool_call_failure"].includes(event.stage)
    || !["ok", "error"].includes(String(event.outcome))
    || typeof event.appVersion !== "string"
    || !Number.isSafeInteger(event.unixSeconds)
  ) return null;
  return value as PendingPilotEvent;
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

function safeErrorCode(value: string): string {
  return /^[A-Z0-9_]{3,48}$/.test(value) ? value : "TOOL_FAILED";
}

function telemetryDirectory(config: DashouConfig): string {
  return join(config.stateDir, TELEMETRY_DIRECTORY);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
