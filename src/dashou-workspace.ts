import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { expandHome } from "./dashou-config.js";
import {
  digestToolArguments,
  JsonlDashouEventJournal,
  NoopDashouEventJournal,
  type DashouEventJournal,
} from "./dashou-event-journal.js";
import {
  DashouInstructionResolver,
  type DashouInstructionContext,
  type DashouProjectInstruction,
} from "./dashou-instructions.js";
import { DashouPermissionGate, type DashouToolAction } from "./dashou-permissions.js";
import { userCommandEnvironment } from "./dashou-runtime-contract.js";

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_COMMAND_BUFFER = 4 * 1024 * 1024;
const MAX_VISIBLE_OUTPUT = 120_000;
export type { DashouProjectInstruction } from "./dashou-instructions.js";
export interface DashouProject {
  name: string;
  path: string;
  available: boolean;
}

export interface DashouWorkspace {
  id: string;
  root: string;
  instructions: DashouProjectInstruction[];
  availableInstructionFiles: string[];
  instructionsDigest: string;
  contextVersion: number;
  deliveredScopes: Record<string, string>;
}

export interface DashouContextUpdate {
  reason: "scope_entered" | "instructions_changed" | "version_mismatch";
  contextVersion: number;
  scope: string;
  instructions: DashouProjectInstruction[];
  instructionsDigest: string;
}

export interface DashouReadResult {
  result: string;
  contextVersion: number;
  contextUpdate?: DashouContextUpdate;
}

export interface DashouMutationResult {
  contextVersion: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  contextVersion: number;
}

export class ContextRefreshRequiredError extends Error {
  readonly code = "context_refresh_required";

  constructor(readonly contextUpdate: DashouContextUpdate) {
    super(`Project context must be refreshed before this change (current contextVersion ${contextUpdate.contextVersion}).`);
    this.name = "ContextRefreshRequiredError";
  }
}

export class InstructionContextTooLargeError extends Error {
  readonly code = "instruction_context_too_large";

  constructor(
    readonly contextVersion: number,
    readonly truncatedInstructionPaths: string[],
    readonly contextUpdate?: DashouContextUpdate,
  ) {
    super(
      `Applicable project instructions are too large to deliver completely: ${truncatedInstructionPaths.join(", ")}. `
      + "Refusing write, edit, or execute until the instruction files are reduced.",
    );
    this.name = "InstructionContextTooLargeError";
  }
}

export class DashouWorkspaceRegistry {
  private readonly workspaces = new Map<string, DashouWorkspace>();
  private readonly instructionResolvers = new Map<string, DashouInstructionResolver>();
  private readonly permissionGate: DashouPermissionGate;
  private readonly journal: DashouEventJournal;
  private closePromise?: Promise<void>;

  constructor(
    private readonly allowedRoots: string[],
    options: {
      allowProjectCommands?: boolean;
      stateDir?: string;
      journal?: DashouEventJournal;
    } = {},
  ) {
    const allowProjectCommands = options.allowProjectCommands
      ?? process.env.DASHOU_ALLOW_PROJECT_COMMANDS === "1";
    this.permissionGate = new DashouPermissionGate(allowProjectCommands);
    this.journal = options.journal
      ?? (options.stateDir ? new JsonlDashouEventJournal(options.stateDir) : new NoopDashouEventJournal());
  }

  async listProjects(): Promise<DashouProject[]> {
    const projects: DashouProject[] = [];
    const seen = new Set<string>();

    for (const configuredRoot of this.allowedRoots) {
      const configuredPath = resolve(expandHome(configuredRoot));
      let projectPath = configuredPath;
      let available = false;

      try {
        projectPath = await realpath(configuredPath);
        const metadata = await stat(projectPath);
        if (!metadata.isDirectory()) continue;
        available = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (seen.has(projectPath)) continue;
      seen.add(projectPath);
      projects.push({
        name: basename(projectPath) || projectPath,
        path: projectPath,
        available,
      });
    }

    return projects.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  }

  async openProject(inputPath: string): Promise<DashouWorkspace> {
    const candidate = resolve(expandHome(inputPath));
    const root = await realpath(candidate);
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) throw new Error(`Project path is not a directory: ${inputPath}`);

    const allowed = await this.isInsideAllowedRoot(root);
    if (!allowed) throw new Error(`Project path is outside approved roots: ${inputPath}`);

    const resolver = new DashouInstructionResolver(root);
    const context = await resolver.resolveForPath(root, true);
    const workspace: DashouWorkspace = {
      id: `ws_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      root,
      instructions: context.instructions,
      availableInstructionFiles: await resolver.availableInstructionFiles(),
      instructionsDigest: context.instructionsDigest,
      contextVersion: 1,
      deliveredScopes: { [context.scope]: context.instructionsDigest },
    };
    this.workspaces.set(workspace.id, workspace);
    this.instructionResolvers.set(workspace.id, resolver);
    await this.journal.append({ event: "workspace/opened", workspaceId: workspace.id });
    await this.journal.append({
      event: "context/delivered",
      workspaceId: workspace.id,
      contextVersion: workspace.contextVersion,
      target: context.scope,
      reason: "project_opened",
    });
    return workspace;
  }

  requireWorkspace(workspaceId: string): DashouWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspaceId: ${workspaceId}`);
    return workspace;
  }

  async readText(
    workspaceId: string,
    filePath: string,
    offset = 1,
    limit?: number,
  ): Promise<DashouReadResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const path = await this.resolveExistingFile(workspace, filePath);
    const operation = await this.authorize(workspace, "read", path, filePath, { filePath, offset, limit });
    try {
      const fileStats = await stat(path);
      if (fileStats.size > MAX_READ_BYTES) {
        throw new Error(`File is too large to read directly (${fileStats.size} bytes, max ${MAX_READ_BYTES})`);
      }
      const content = await readFile(path);
      if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) {
        throw new Error("Binary files are not supported by read");
      }

      const text = content.toString("utf8");
      const lines = text.split("\n");
      const start = Math.max(0, offset - 1);
      const selected = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit);
      const result = selected.join("\n");
      await this.completeOperation(workspace, "read", filePath, operation.argumentsDigest);
      return { result, contextVersion: workspace.contextVersion, ...(operation.contextUpdate ? { contextUpdate: operation.contextUpdate } : {}) };
    } catch (error) {
      await this.failOperation(workspace, "read", filePath, operation.argumentsDigest, error);
      throw error;
    }
  }

  async writeText(
    workspaceId: string,
    filePath: string,
    content: string,
    contextVersion: number,
  ): Promise<DashouMutationResult & { byteLength: number }> {
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_WRITE_BYTES) {
      throw new Error(`Content is too large to write directly (max ${MAX_WRITE_BYTES} bytes)`);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const target = await this.resolveWritableFile(workspace, filePath);
    const operation = await this.authorize(
      workspace,
      "write",
      target,
      filePath,
      { filePath, content },
      contextVersion,
    );
    try {
      await mkdir(dirname(target), { recursive: true });
      await this.assertPhysicalPathInside(workspace.root, dirname(target));
      await atomicWrite(target, content);
      await this.completeOperation(workspace, "write", filePath, operation.argumentsDigest);
      return { byteLength, contextVersion: workspace.contextVersion };
    } catch (error) {
      await this.failOperation(workspace, "write", filePath, operation.argumentsDigest, error);
      throw error;
    }
  }

  async editText(
    workspaceId: string,
    filePath: string,
    edits: Array<{ oldText: string; newText: string }>,
    contextVersion: number,
  ): Promise<DashouMutationResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const target = await this.resolveExistingFile(workspace, filePath, { rejectSymlink: true });
    const operation = await this.authorize(
      workspace,
      "edit",
      target,
      filePath,
      { filePath, edits },
      contextVersion,
    );
    try {
      const fileStats = await stat(target);
      if (fileStats.size > MAX_WRITE_BYTES) {
        throw new Error(`File is too large to edit directly (${fileStats.size} bytes, max ${MAX_WRITE_BYTES})`);
      }
      let content = await readFile(target, "utf8");

      for (const edit of edits) {
        if (!edit.oldText) throw new Error("oldText must not be empty");
        const first = content.indexOf(edit.oldText);
        if (first < 0) throw new Error("oldText was not found in the file");
        const second = content.indexOf(edit.oldText, first + edit.oldText.length);
        if (second >= 0) throw new Error("oldText matches more than once; provide a more specific block");
        content = content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length);
      }

      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        throw new Error(`Edited content exceeds ${MAX_WRITE_BYTES} bytes`);
      }
      await atomicWrite(target, content);
      await this.completeOperation(workspace, "edit", filePath, operation.argumentsDigest);
      return { contextVersion: workspace.contextVersion };
    } catch (error) {
      await this.failOperation(workspace, "edit", filePath, operation.argumentsDigest, error);
      throw error;
    }
  }

  async execute(
    workspaceId: string,
    command: string,
    workingDirectory?: string,
    timeoutSeconds = 30,
    contextVersion?: number,
  ): Promise<CommandResult> {
    const workspace = this.requireWorkspace(workspaceId);
    if (!command.trim()) throw new Error("command must not be empty");
    if (timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("timeoutSeconds must be between 1 and 300");
    assertCommandAccidentGuard(command);

    const cwd = workingDirectory
      ? await this.resolveExistingDirectory(workspace, workingDirectory)
      : workspace.root;
    const operation = await this.authorize(
      workspace,
      "execute",
      cwd,
      workingDirectory || ".",
      { command, workingDirectory, timeoutSeconds },
      contextVersion,
      true,
    );
    const shell = process.platform === "win32" ? "bash" : "/bin/bash";

    try {
      const result = await execFileAsync(shell, ["--noprofile", "--norc", "-c", command], {
        cwd,
        timeout: timeoutSeconds * 1000,
        maxBuffer: MAX_COMMAND_BUFFER,
        encoding: "utf8",
        env: { ...userCommandEnvironment(), PWD: cwd },
      });
      const commandResult = boundedCommandResult(result.stdout, result.stderr, 0, workspace.contextVersion);
      await this.completeOperation(workspace, "execute", workingDirectory || ".", operation.argumentsDigest);
      return commandResult;
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
        killed?: boolean;
      };
      if (execError.code === "ETIMEDOUT" || execError.killed) {
        await this.failOperation(workspace, "execute", workingDirectory || ".", operation.argumentsDigest, error);
        throw new Error(`Command timed out after ${timeoutSeconds}s`);
      }
      if (typeof execError.code === "number") {
        const commandResult = boundedCommandResult(
          execError.stdout ?? "",
          execError.stderr ?? "",
          execError.code,
          workspace.contextVersion,
        );
        await this.completeOperation(workspace, "execute", workingDirectory || ".", operation.argumentsDigest);
        return commandResult;
      }
      await this.failOperation(workspace, "execute", workingDirectory || ".", operation.argumentsDigest, error);
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    this.closePromise ??= (async () => {
      for (const workspace of this.workspaces.values()) {
        await this.journal.append({ event: "workspace/closed", workspaceId: workspace.id });
      }
      this.workspaces.clear();
      this.instructionResolvers.clear();
    })();
    return this.closePromise;
  }

  private async authorize(
    workspace: DashouWorkspace,
    action: DashouToolAction,
    physicalTarget: string,
    target: string,
    argumentsValue: unknown,
    providedContextVersion?: number,
    targetIsDirectory = false,
  ): Promise<{ argumentsDigest: string; contextUpdate?: DashouContextUpdate }> {
    const argumentsDigest = digestToolArguments(argumentsValue);
    await this.journal.append({
      event: "tool/requested",
      workspaceId: workspace.id,
      action,
      target,
      argumentsDigest,
      contextVersion: workspace.contextVersion,
    });

    const context = await this.requireResolver(workspace.id).resolveForPath(physicalTarget, targetIsDirectory);
    if (context.scope === ".") {
      workspace.instructions = context.instructions;
      workspace.instructionsDigest = context.instructionsDigest;
    }
    const previousDigest = workspace.deliveredScopes[context.scope];
    let contextUpdate: DashouContextUpdate | undefined;
    if (previousDigest !== context.instructionsDigest) {
      workspace.contextVersion += 1;
      workspace.deliveredScopes[context.scope] = context.instructionsDigest;
      const reason = previousDigest === undefined ? "scope_entered" : "instructions_changed";
      contextUpdate = makeContextUpdate(context, workspace.contextVersion, reason);
      await this.journal.append({
        event: "context/delivered",
        workspaceId: workspace.id,
        target: context.scope,
        contextVersion: workspace.contextVersion,
        reason,
      });
    }

    const truncatedInstructionPaths = context.instructions
      .filter((instruction) => instruction.truncated)
      .map((instruction) => instruction.path);
    if (action !== "read" && truncatedInstructionPaths.length > 0) {
      await this.journal.append({
        event: "tool/denied",
        workspaceId: workspace.id,
        action,
        target,
        argumentsDigest,
        contextVersion: workspace.contextVersion,
        reason: "instruction_context_too_large",
      });
      throw new InstructionContextTooLargeError(
        workspace.contextVersion,
        truncatedInstructionPaths,
        contextUpdate,
      );
    }

    if (action !== "read" && (contextUpdate || providedContextVersion !== workspace.contextVersion)) {
      const refresh = contextUpdate
        ?? makeContextUpdate(context, workspace.contextVersion, "version_mismatch");
      await this.journal.append({
        event: "tool/denied",
        workspaceId: workspace.id,
        action,
        target,
        argumentsDigest,
        contextVersion: workspace.contextVersion,
        reason: refresh.reason,
      });
      throw new ContextRefreshRequiredError(refresh);
    }

    const decision = this.permissionGate.decide(action);
    if (!decision.allowed) {
      await this.journal.append({
        event: "tool/denied",
        workspaceId: workspace.id,
        action,
        target,
        argumentsDigest,
        contextVersion: workspace.contextVersion,
        reason: decision.reason,
      });
      throw new Error(decision.reason);
    }
    await this.journal.append({
      event: "tool/allowed",
      workspaceId: workspace.id,
      action,
      target,
      argumentsDigest,
      contextVersion: workspace.contextVersion,
      reason: decision.reason,
    });
    return { argumentsDigest, ...(contextUpdate ? { contextUpdate } : {}) };
  }

  private async completeOperation(
    workspace: DashouWorkspace,
    action: DashouToolAction,
    target: string,
    argumentsDigest: string,
  ): Promise<void> {
    await this.journal.append({
      event: "tool/completed",
      workspaceId: workspace.id,
      action,
      target,
      argumentsDigest,
      contextVersion: workspace.contextVersion,
    });
  }

  private async failOperation(
    workspace: DashouWorkspace,
    action: DashouToolAction,
    target: string,
    argumentsDigest: string,
    error: unknown,
  ): Promise<void> {
    await this.journal.append({
      event: "tool/failed",
      workspaceId: workspace.id,
      action,
      target,
      argumentsDigest,
      contextVersion: workspace.contextVersion,
      reason: error instanceof Error ? error.name : "unknown_error",
    });
  }

  private requireResolver(workspaceId: string): DashouInstructionResolver {
    const resolver = this.instructionResolvers.get(workspaceId);
    if (!resolver) throw new Error(`Unknown workspaceId: ${workspaceId}`);
    return resolver;
  }

  private async resolveExistingFile(
    workspace: DashouWorkspace,
    inputPath: string,
    options: { rejectSymlink?: boolean } = {},
  ): Promise<string> {
    const lexical = this.lexicalProjectPath(workspace, inputPath);
    if (options.rejectSymlink) {
      const metadata = await lstat(lexical);
      if (metadata.isSymbolicLink()) throw new Error("Editing through symbolic links is not allowed");
    }
    const physical = await realpath(lexical);
    this.assertInside(workspace.root, physical);
    const metadata = await stat(physical);
    if (!metadata.isFile()) throw new Error(`Not a file: ${inputPath}`);
    return physical;
  }

  private async resolveWritableFile(workspace: DashouWorkspace, inputPath: string): Promise<string> {
    const lexical = this.lexicalProjectPath(workspace, inputPath);
    try {
      const metadata = await lstat(lexical);
      if (metadata.isSymbolicLink()) throw new Error("Writing through symbolic links is not allowed");
      const physical = await realpath(lexical);
      this.assertInside(workspace.root, physical);
      if (!metadata.isFile()) throw new Error(`Not a file: ${inputPath}`);
      return physical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const ancestor = await nearestExistingAncestor(dirname(lexical));
    const physicalAncestor = await realpath(ancestor);
    this.assertInside(workspace.root, physicalAncestor);
    return lexical;
  }

  private async resolveExistingDirectory(workspace: DashouWorkspace, inputPath: string): Promise<string> {
    const lexical = this.lexicalProjectPath(workspace, inputPath);
    const physical = await realpath(lexical);
    this.assertInside(workspace.root, physical);
    const metadata = await stat(physical);
    if (!metadata.isDirectory()) throw new Error(`Not a directory: ${inputPath}`);
    return physical;
  }

  private lexicalProjectPath(workspace: DashouWorkspace, inputPath: string): string {
    if (isAbsolute(inputPath)) throw new Error("Use project-relative paths after open_project");
    const candidate = resolve(workspace.root, inputPath || ".");
    this.assertInside(workspace.root, candidate);
    return candidate;
  }

  private async isInsideAllowedRoot(projectRoot: string): Promise<boolean> {
    for (const configuredRoot of this.allowedRoots) {
      try {
        const allowedRoot = await realpath(resolve(expandHome(configuredRoot)));
        if (isInside(allowedRoot, projectRoot)) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return false;
  }

  private async assertPhysicalPathInside(projectRoot: string, inputPath: string): Promise<void> {
    const physical = await realpath(inputPath);
    this.assertInside(projectRoot, physical);
  }

  private assertInside(root: string, candidate: string): void {
    if (!isInside(root, candidate)) throw new Error("Path is outside the opened project");
  }
}

function isInside(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate);
  return relationship === "" || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function nearestExistingAncestor(inputPath: string): Promise<string> {
  let current = inputPath;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`No existing ancestor for ${inputPath}`);
      current = parent;
    }
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const tempPath = `${target}.dashou-${process.pid}-${randomUUID()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode });
    await rename(tempPath, target);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function assertCommandAccidentGuard(command: string): void {
  const blocked: Array<[RegExp, string]> = [
    [/\bsudo\b/i, "sudo is blocked by the V0 accident guard"],
    [/\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/i, "recursive forced rm is blocked"],
    [/\b(shutdown|reboot|halt|poweroff)\b/i, "system shutdown commands are blocked"],
    [/\b(mkfs|fdisk)\b/i, "disk formatting commands are blocked"],
    [/\bdiskutil\s+(erase|partition)/i, "disk erase/partition commands are blocked"],
    [/(curl|wget)[^\n|]*\|\s*(sh|bash)\b/i, "piping downloaded code directly to a shell is blocked"],
  ];
  for (const [pattern, reason] of blocked) {
    if (pattern.test(command)) throw new Error(reason);
  }
}

function boundedCommandResult(
  stdout: string,
  stderr: string,
  exitCode: number,
  contextVersion: number,
): CommandResult {
  let remaining = MAX_VISIBLE_OUTPUT;
  const boundedStdout = stdout.slice(0, remaining);
  remaining -= boundedStdout.length;
  const boundedStderr = stderr.slice(0, Math.max(0, remaining));
  return {
    stdout: boundedStdout,
    stderr: boundedStderr,
    exitCode,
    truncated: boundedStdout.length < stdout.length || boundedStderr.length < stderr.length,
    contextVersion,
  };
}

function makeContextUpdate(
  context: DashouInstructionContext,
  contextVersion: number,
  reason: DashouContextUpdate["reason"],
): DashouContextUpdate {
  return {
    reason,
    contextVersion,
    scope: context.scope,
    instructions: context.instructions,
    instructionsDigest: context.instructionsDigest,
  };
}
