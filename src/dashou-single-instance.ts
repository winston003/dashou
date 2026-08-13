import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface DashouServeInstanceLock {
  path: string;
  release(): void;
}

/** Prevent two Dashou daemons from competing for the same OAuth/state store. */
export function acquireServeInstanceLock(
  stateDir: string,
  pid = process.pid,
): DashouServeInstanceLock {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, "serve.lock");

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "pid"), `${pid}\n`, { mode: 0o600 });
      return {
        path: lockPath,
        release: () => releaseOwnedLock(lockPath, pid),
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;

      const ownerPid = readLockPid(lockPath);
      if (
        ownerPid !== undefined
        && processIsAlive(ownerPid)
        && (ownerPid === pid || processIsDashouServe(ownerPid))
      ) {
        throw new Error(
          `Dashou 已经在运行（PID ${ownerPid}）。请先停止现有服务，再启动新的服务。`,
        );
      }

      const stalePath = `${lockPath}.stale-${pid}-${Date.now()}`;
      try {
        renameSync(lockPath, stalePath);
      } catch (renameError) {
        if (isMissing(renameError) || isAlreadyExists(renameError)) continue;
        throw renameError;
      }
      rmSync(stalePath, { recursive: true, force: true });
    }
  }
}

export function isDashouServeCommand(command: string): boolean {
  const tokens = command.replaceAll("\\\\", "/").trim().split(/\s+/u);
  const executable = tokens[0]?.split("/").at(-1);
  if (executable !== "node") return false;
  const entryIndex = tokens.findIndex((token) => /(?:^|\/)dist\/dashou-cli\.js$/u.test(token));
  return entryIndex >= 0 && tokens[entryIndex + 1] === "serve";
}

function releaseOwnedLock(lockPath: string, pid: number): void {
  if (readLockPid(lockPath) !== pid) return;
  rmSync(lockPath, { recursive: true, force: true });
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(join(lockPath, "pid"), "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function processIsDashouServe(pid: number): boolean {
  let command: string;
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // If process inspection is unavailable, fail closed rather than deleting
    // a lock that may belong to a live Dashou process.
    return true;
  }
  return command ? isDashouServeCommand(command) : true;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
