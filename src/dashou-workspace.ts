import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  opendir,
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
import { userCommandEnvironment } from "./dashou-runtime-contract.js";

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_COMMAND_BUFFER = 4 * 1024 * 1024;
const MAX_VISIBLE_OUTPUT = 120_000;
const MAX_INSTRUCTION_BYTES = 2 * 1024 * 1024;
const MAX_INSTRUCTION_DISCOVERY_ENTRIES = 20_000;
const PROJECT_INSTRUCTION_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_INSTRUCTION_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "target",
]);

export interface DashouProjectInstruction {
  path: string;
  content: string;
}
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
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export class DashouWorkspaceRegistry {
  private readonly workspaces = new Map<string, DashouWorkspace>();
  private readonly projectIds = new Map<string, string>();
  private readonly allowProjectCommands: boolean;

  constructor(
    private readonly allowedRoots: string[],
    options: { allowProjectCommands?: boolean } = {},
  ) {
    this.allowProjectCommands = options.allowProjectCommands
      ?? process.env.DASHOU_ALLOW_PROJECT_COMMANDS === "1";
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

    const existingId = this.projectIds.get(root);
    if (existingId) return this.requireWorkspace(existingId);

    const context = await loadProjectContext(root);
    const workspace: DashouWorkspace = {
      id: `ws_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      root,
      ...context,
    };
    this.workspaces.set(workspace.id, workspace);
    this.projectIds.set(root, workspace.id);
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
  ): Promise<string> {
    const workspace = this.requireWorkspace(workspaceId);
    const path = await this.resolveExistingFile(workspace, filePath);
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
    return selected.join("\n");
  }

  async writeText(workspaceId: string, filePath: string, content: string): Promise<number> {
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_WRITE_BYTES) {
      throw new Error(`Content is too large to write directly (max ${MAX_WRITE_BYTES} bytes)`);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const target = await this.resolveWritableFile(workspace, filePath);
    await mkdir(dirname(target), { recursive: true });
    await this.assertPhysicalPathInside(workspace.root, dirname(target));
    await atomicWrite(target, content);
    return byteLength;
  }

  async editText(
    workspaceId: string,
    filePath: string,
    edits: Array<{ oldText: string; newText: string }>,
  ): Promise<void> {
    const workspace = this.requireWorkspace(workspaceId);
    const target = await this.resolveExistingFile(workspace, filePath, { rejectSymlink: true });
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
  }

  async execute(
    workspaceId: string,
    command: string,
    workingDirectory?: string,
    timeoutSeconds = 30,
  ): Promise<CommandResult> {
    if (!this.allowProjectCommands) {
      throw new Error("这台电脑尚未允许项目命令。请打开搭手 → 设置，开启“允许 ChatGPT 运行项目命令”后再试。");
    }
    const workspace = this.requireWorkspace(workspaceId);
    if (!command.trim()) throw new Error("command must not be empty");
    if (timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("timeoutSeconds must be between 1 and 300");
    assertCommandAccidentGuard(command);

    const cwd = workingDirectory
      ? await this.resolveExistingDirectory(workspace, workingDirectory)
      : workspace.root;
    const shell = process.platform === "win32" ? "bash" : "/bin/bash";

    try {
      // Keep the sanitized daemon environment authoritative. User shell startup
      // files can replace the pinned Node runtime in PATH, even for commands
      // launched from a long-lived desktop process.
      const result = await execFileAsync(shell, ["--noprofile", "--norc", "-c", command], {
        cwd,
        timeout: timeoutSeconds * 1000,
        maxBuffer: MAX_COMMAND_BUFFER,
        encoding: "utf8",
        env: { ...userCommandEnvironment(), PWD: cwd },
      });
      return boundedCommandResult(result.stdout, result.stderr, 0);
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
        killed?: boolean;
      };
      if (execError.code === "ETIMEDOUT" || execError.killed) {
        throw new Error(`Command timed out after ${timeoutSeconds}s`);
      }
      if (typeof execError.code === "number") {
        return boundedCommandResult(execError.stdout ?? "", execError.stderr ?? "", execError.code);
      }
      throw error;
    }
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

interface DashouProjectContext {
  instructions: DashouProjectInstruction[];
  availableInstructionFiles: string[];
  instructionsDigest: string;
}

async function loadProjectContext(root: string): Promise<DashouProjectContext> {
  const discovered: string[] = [];
  await discoverInstructionFiles(root, discovered, { count: 0 });

  const relativePaths = discovered
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
  const rootInstructionPaths = relativePaths.filter((path) => !path.includes("/"));
  const nestedInstructionPaths = relativePaths.filter((path) => path.includes("/"));
  const instructions: DashouProjectInstruction[] = [];

  for (const path of rootInstructionPaths) {
    const content = await readInstructionFile(root, join(root, ...path.split("/")));
    if (content !== undefined) instructions.push({ path, content });
  }

  const instructionsDigest = createHash("sha256")
    .update(JSON.stringify({ instructions, availableInstructionFiles: nestedInstructionPaths }))
    .digest("hex");

  return {
    instructions,
    availableInstructionFiles: nestedInstructionPaths,
    instructionsDigest,
  };
}

async function discoverInstructionFiles(
  current: string,
  discovered: string[],
  budget: { count: number },
): Promise<void> {
  if (budget.count >= MAX_INSTRUCTION_DISCOVERY_ENTRIES) return;

  let directory;
  try {
    directory = await opendir(current);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return;
    throw error;
  }

  for await (const entry of directory) {
    budget.count += 1;
    if (budget.count > MAX_INSTRUCTION_DISCOVERY_ENTRIES) return;
    if (entry.isSymbolicLink()) continue;

    const path = join(current, entry.name);
    if (entry.isFile() && PROJECT_INSTRUCTION_NAMES.has(entry.name)) {
      discovered.push(path);
      continue;
    }
    if (entry.isDirectory() && !SKIPPED_INSTRUCTION_DIRECTORIES.has(entry.name)) {
      await discoverInstructionFiles(path, discovered, budget);
    }
  }
}

async function readInstructionFile(root: string, path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const physical = await realpath(path);
    if (!isInside(root, physical)) return undefined;
    const content = await readFile(physical);
    if (content.length <= MAX_INSTRUCTION_BYTES) return content.toString("utf8");
    return `${content.subarray(0, MAX_INSTRUCTION_BYTES).toString("utf8")}\n\n[Project instruction truncated at ${MAX_INSTRUCTION_BYTES} bytes.]`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return undefined;
    throw error;
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

function boundedCommandResult(stdout: string, stderr: string, exitCode: number): CommandResult {
  let remaining = MAX_VISIBLE_OUTPUT;
  const boundedStdout = stdout.slice(0, remaining);
  remaining -= boundedStdout.length;
  const boundedStderr = stderr.slice(0, Math.max(0, remaining));
  return {
    stdout: boundedStdout,
    stderr: boundedStderr,
    exitCode,
    truncated: boundedStdout.length < stdout.length || boundedStderr.length < stderr.length,
  };
}
