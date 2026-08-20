import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DASHOU_NODE_RANGE = ">=22.19 <27";

export interface DashouRuntimeContractReport {
  ok: boolean;
  requiredNode: string;
  nodeVersion: string;
  nodeAbi: string;
  nodeExecutable: string;
  pathNodeExecutable: string | null;
  pathNpmExecutable: string | null;
  pathNpxExecutable: string | null;
  effectivePath: string;
  issues: string[];
}

function pathDelimiter(platform = process.platform): string {
  return platform === "win32" ? ";" : ":";
}

function pathEntries(pathValue: string, platform = process.platform): string[] {
  return pathValue.split(pathDelimiter(platform)).map((entry) => entry.trim()).filter(Boolean);
}

function executableNames(name: string, platform = process.platform): string[] {
  return platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
}

function normalizedPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

export function findPathExecutable(name: string, pathValue = process.env.PATH ?? "", platform = process.platform): string | null {
  for (const directory of pathEntries(pathValue, platform)) {
    for (const executable of executableNames(name, platform)) {
      const candidate = join(directory, executable);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  return null;
}

function supportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 19) || (major > 22 && major < 27);
}

export function runtimeExecutablePath(runtimeExecPath = process.execPath, inheritedPath = process.env.PATH ?? "", platform = process.platform): string {
  const runtimeBin = dirname(resolve(runtimeExecPath));
  const delimiter = pathDelimiter(platform);
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [runtimeBin, ...pathEntries(inheritedPath, platform)]) {
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join(delimiter);
}

/** Keep Node-owned child commands on the same runtime as the Dashou daemon. */
export function runtimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  runtimeExecPath = process.execPath,
  platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: runtimeExecutablePath(runtimeExecPath, environment.PATH ?? "", platform),
  };
}

const USER_COMMAND_ENVIRONMENT_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATHEXT",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "WINDIR",
] as const;

/**
 * Environment exposed to project commands.
 *
 * The Dashou daemon needs control-plane, tunnel, and application credentials,
 * but a project command must never inherit that ambient authority. Keep this
 * list intentionally small; project-specific values should be supplied by the
 * project itself instead of copied from the long-lived service process.
 */
export function userCommandEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  runtimeExecPath = process.execPath,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of USER_COMMAND_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) sanitized[key] = value;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (/^LC_[A-Z0-9_]+$/.test(key) && value !== undefined) sanitized[key] = value;
  }
  sanitized.PATH = runtimeExecutablePath(runtimeExecPath, environment.PATH ?? "", platform);
  return sanitized;
}

export function runtimeContractReport(env: NodeJS.ProcessEnv = process.env, runtimeExecPath = process.execPath, nodeVersion = process.version, nodeAbi = process.versions.modules): DashouRuntimeContractReport {
  const inheritedPath = env.PATH ?? "";
  const pathNodeExecutable = findPathExecutable("node", inheritedPath);
  const pathNpmExecutable = findPathExecutable("npm", inheritedPath);
  const pathNpxExecutable = findPathExecutable("npx", inheritedPath);
  const nodeExecutable = normalizedPath(runtimeExecPath);
  const issues: string[] = [];

  if (!supportedNode(nodeVersion)) issues.push(`Node ${nodeVersion} is outside ${DASHOU_NODE_RANGE}`);
  if (!pathNodeExecutable) issues.push("PATH does not contain an executable node");
  else if (normalizedPath(pathNodeExecutable) !== nodeExecutable) issues.push(`PATH node ${normalizedPath(pathNodeExecutable)} does not match daemon ${nodeExecutable}`);
  // The desktop bundle carries its own Node runtime and deliberately does not
  // ship npm/npx. CLI installs still require both package managers.
  const embeddedRuntime = ["1", "true", "yes", "on"].includes((env.DASHOU_EMBEDDED_RUNTIME ?? "").toLowerCase());
  if (!embeddedRuntime && !pathNpmExecutable) issues.push("PATH does not contain an executable npm");
  if (!embeddedRuntime && !pathNpxExecutable) issues.push("PATH does not contain an executable npx");

  return {
    ok: issues.length === 0,
    requiredNode: DASHOU_NODE_RANGE,
    nodeVersion,
    nodeAbi,
    nodeExecutable,
    pathNodeExecutable: pathNodeExecutable ? normalizedPath(pathNodeExecutable) : null,
    pathNpmExecutable: pathNpmExecutable ? normalizedPath(pathNpmExecutable) : null,
    pathNpxExecutable: pathNpxExecutable ? normalizedPath(pathNpxExecutable) : null,
    effectivePath: runtimeExecutablePath(runtimeExecPath, inheritedPath),
    issues,
  };
}

export function formatRuntimeContract(report: DashouRuntimeContractReport): string {
  return [
    `ok: ${report.ok}`,
    `node: ${report.nodeVersion}`,
    `nodeAbi: ${report.nodeAbi}`,
    `requiredNode: ${report.requiredNode}`,
    `daemonExecutable: ${report.nodeExecutable}`,
    `pathNode: ${report.pathNodeExecutable ?? "missing"}`,
    `pathNpm: ${report.pathNpmExecutable ?? "missing"}`,
    `pathNpx: ${report.pathNpxExecutable ?? "missing"}`,
    `effectivePath: ${report.effectivePath}`,
    ...(report.issues.length > 0 ? ["issues:", ...report.issues.map((issue) => `- ${issue}`)] : []),
  ].join("\n");
}
