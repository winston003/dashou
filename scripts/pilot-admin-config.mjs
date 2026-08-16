import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_PILOT_CONTROL_URL = "https://dashou-pilot-control.whilewon.workers.dev";

export function pilotAdminConfigPath(env = process.env) {
  const configured = env.DASHOU_PILOT_ADMIN_CONFIG?.trim();
  if (configured) return resolve(expandHome(configured));
  const configDir = env.DASHOU_CONFIG_DIR?.trim() || join(homedir(), ".dashou");
  return join(resolve(expandHome(configDir)), "pilot-admin.json");
}

export function loadPilotAdminConfig(env = process.env) {
  const path = pilotAdminConfigPath(env);
  if (!existsSync(path)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取管理员配置 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`管理员配置格式无效：${path}`);
  return {
    controlPlaneUrl: typeof parsed.controlPlaneUrl === "string" ? parsed.controlPlaneUrl.trim() : undefined,
    adminToken: typeof parsed.adminToken === "string" ? parsed.adminToken.trim() : undefined,
  };
}

export function writePilotAdminConfig(config, env = process.env) {
  const path = pilotAdminConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({
    version: 1,
    controlPlaneUrl: config.controlPlaneUrl,
    adminToken: config.adminToken,
  }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may not support POSIX modes; the file is still kept outside the repo.
  }
  return path;
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
