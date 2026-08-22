import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DashouToolAction } from "./dashou-permissions.js";

export type DashouHarnessEventType =
  | "workspace/opened"
  | "workspace/closed"
  | "context/delivered"
  | "tool/requested"
  | "tool/allowed"
  | "tool/denied"
  | "tool/completed"
  | "tool/failed";

export interface DashouHarnessEvent {
  event: DashouHarnessEventType;
  workspaceId: string;
  action?: DashouToolAction;
  target?: string;
  argumentsDigest?: string;
  contextVersion?: number;
  reason?: string;
}

export interface DashouEventJournal {
  append(event: DashouHarnessEvent): Promise<void>;
}

export class NoopDashouEventJournal implements DashouEventJournal {
  async append(_event: DashouHarnessEvent): Promise<void> {}
}

export class JsonlDashouEventJournal implements DashouEventJournal {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.path = join(stateDir, "harness", "events.jsonl");
  }

  async append(event: DashouHarnessEvent): Promise<void> {
    const record = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    const operation = this.queue.then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await appendFile(this.path, record, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
    });
    // Report this append's error to its caller, but keep the serialization
    // chain usable after a transient filesystem failure.
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

export function digestToolArguments(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
