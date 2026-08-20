import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ConnectionMilestone =
  | "authorization-requested"
  | "oauth-completed"
  | "first-mcp-session"
  | "first-tool-success";

export function markConnectionMilestone(stateDir: string, milestone: ConnectionMilestone): boolean {
  let temporary: string | undefined;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const target = join(stateDir, `connection-${milestone}`);
    temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${Math.floor(Date.now() / 1000)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
    return true;
  } catch {
    if (temporary) rmSync(temporary, { force: true });
    return false;
  }
}
