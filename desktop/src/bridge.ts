import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { AccessStatus, AvailableUpdate, DesktopSnapshot, Preferences } from "./types";

export const CHATGPT_APPS_URL = "https://chatgpt.com/plugins?view=personal";

export type Bridge = {
  snapshot(): Promise<DesktopSnapshot>;
  copyCatalog(): Promise<Record<string, string>>;
  confirmUiReady(version: string): Promise<void>;
  checkContentUpdates(): Promise<Record<string, string> | void>;
  applyForAccess(): Promise<AccessStatus>;
  applicationStatus(): Promise<AccessStatus>;
  updateRoots(allowedRoots: string[]): Promise<DesktopSnapshot>;
  setPreferences(preferences: Partial<Preferences>): Promise<DesktopSnapshot>;
  restartRuntime(): Promise<DesktopSnapshot>;
  connectionCode(): Promise<string | null>;
  markChatGPTSetupOpened(): Promise<void>;
  diagnosticReport(): Promise<unknown>;
  recordEvent(stage: string, outcome?: "ok" | "error", errorCode?: string, applicationId?: string): Promise<void>;
  chooseFolders(title: string): Promise<string[]>;
  importInvite(title: string): Promise<void>;
  openChatGPT(): Promise<void>;
  copy(value: string): Promise<void>;
  checkUpdate(): Promise<AvailableUpdate | null>;
  installUpdate(): Promise<void>;
  enableNotifications(): Promise<boolean>;
  notifyReady(title: string, body: string): Promise<void>;
};

let pendingUpdate: Update | null = null;

export type BridgeError = Error & {
  code?: string;
  retryable?: boolean;
  diagnosticId?: string;
};

export function normalizeBridgeError(error: unknown): BridgeError {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; retryable?: unknown; diagnosticId?: unknown; message?: unknown };
    if (typeof candidate.code === "string") {
      const normalized = new Error(typeof candidate.message === "string" ? candidate.message : candidate.code) as BridgeError;
      normalized.code = candidate.code;
      normalized.retryable = candidate.retryable === true;
      if (typeof candidate.diagnosticId === "string") normalized.diagnosticId = candidate.diagnosticId;
      return normalized;
    }
  }
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "Unknown bridge error");
  const match = /^\[([A-Z0-9_]{3,64})\]/.exec(raw);
  const normalized = new Error(raw.replace(/^\[[A-Z0-9_]{3,64}\]\s*/, "")) as BridgeError;
  if (match) normalized.code = match[1];
  return normalized;
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeBridgeError(error);
  }
}

async function invokeSnapshot(): Promise<DesktopSnapshot> {
  return invokeCommand<DesktopSnapshot>("desktop_snapshot");
}

export const tauriBridge: Bridge = {
  snapshot: invokeSnapshot,
  copyCatalog: async () => (await invokeCommand<{ messages: Record<string, string> }>("copy_bundle")).messages,
  confirmUiReady: (version) => invokeCommand("ui_ready", { version }),
  checkContentUpdates: async () => {
    return (await invokeCommand<{ messages: Record<string, string> }>("check_copy_update")).messages;
  },
  applyForAccess: () => invokeCommand<AccessStatus>("apply_for_access"),
  applicationStatus: () => invokeCommand<AccessStatus>("application_status"),
  updateRoots: (allowedRoots) => invokeCommand<DesktopSnapshot>("update_allowed_roots", { allowedRoots }),
  setPreferences: (preferences) => invokeCommand<DesktopSnapshot>("set_preferences", preferences),
  restartRuntime: () => invokeCommand<DesktopSnapshot>("restart_runtime"),
  connectionCode: () => invokeCommand<string | null>("connection_code"),
  markChatGPTSetupOpened: () => invokeCommand("mark_chatgpt_setup_opened"),
  diagnosticReport: () => invokeCommand("diagnostic_report"),
  recordEvent: (stage, outcome = "ok", errorCode, applicationId) => invokeCommand("record_client_event", {
    stage,
    outcome,
    errorCode: errorCode ?? null,
    applicationId: applicationId ?? null,
  }),
  chooseFolders: async (title) => {
    const selected = await open({ directory: true, multiple: true, title });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  },
  importInvite: async (title) => {
    const selected = await open({ multiple: false, title, filters: [{ name: title, extensions: ["json"] }] });
    if (typeof selected === "string") await invokeCommand("import_invite", { path: selected });
  },
  openChatGPT: () => invokeCommand("open_chatgpt"),
  copy: (value) => writeText(value),
  checkUpdate: async () => {
    pendingUpdate = await check();
    if (!pendingUpdate) return null;
    return {
      currentVersion: pendingUpdate.currentVersion,
      version: pendingUpdate.version,
      body: pendingUpdate.body,
      date: pendingUpdate.date,
    };
  },
  installUpdate: async () => {
    if (!pendingUpdate) throw new Error("UPDATE_NOT_READY");
    await installDownloadedUpdate(pendingUpdate, (command) => invokeCommand(command), relaunch);
  },
  enableNotifications: async () => {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  },
  notifyReady: async (title, body) => { await sendNotification({ title, body }); },
};

export async function installDownloadedUpdate(
  update: Pick<Update, "download" | "install">,
  invoke: (command: "prepare_for_update" | "restart_runtime") => Promise<unknown>,
  relaunchApp: () => Promise<void>,
): Promise<void> {
  await update.download();
  try {
    await invoke("prepare_for_update");
    await update.install();
    await relaunchApp();
  } catch (error) {
    await invoke("restart_runtime").catch(() => undefined);
    throw error;
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (enabled) await enable();
  else await disable();
}

export async function readAutostart(): Promise<boolean> {
  return isEnabled();
}
