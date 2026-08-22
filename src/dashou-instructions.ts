import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_TOTAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_INSTRUCTION_DISCOVERY_ENTRIES = 20_000;
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

const EXACT_INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"] as const;
const COMPATIBLE_INSTRUCTION_NAMES = new Set(EXACT_INSTRUCTION_NAMES.map((name) => name.toLowerCase()));

export interface DashouProjectInstruction {
  path: string;
  scope: string;
  digest: string;
  content: string;
  truncated: boolean;
}

export interface DashouInstructionContext {
  scope: string;
  instructions: DashouProjectInstruction[];
  instructionsDigest: string;
}

export class DashouInstructionResolver {
  constructor(private readonly root: string) {}

  async availableInstructionFiles(): Promise<string[]> {
    const selected: string[] = [];
    await discoverSelectedInstructionFiles(this.root, selected, { count: 0 });
    return selected
      .map((path) => projectRelativePath(this.root, path))
      .filter((path) => path.includes("/"))
      .sort();
  }

  async resolveForPath(targetPath: string, targetIsDirectory = false): Promise<DashouInstructionContext> {
    const absoluteTarget = resolve(targetPath);
    if (!isInside(this.root, absoluteTarget)) throw new Error("Path is outside the opened project");
    const targetDirectory = targetIsDirectory ? absoluteTarget : dirname(absoluteTarget);
    const directories = directoriesFromRoot(this.root, targetDirectory);
    const selectedFiles: string[] = [];

    for (const directory of directories) {
      const selected = await selectInstructionFile(directory);
      if (selected) selectedFiles.push(selected);
    }

    let remainingBytes = MAX_TOTAL_INSTRUCTION_BYTES;
    const instructions: DashouProjectInstruction[] = [];
    for (const path of [...selectedFiles].reverse()) {
      const instruction = await readInstruction(this.root, path, remainingBytes);
      if (!instruction) continue;
      instructions.unshift(instruction);
      remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(instruction.content, "utf8"));
    }

    const deepestInstructionDirectory = selectedFiles.length > 0
      ? dirname(selectedFiles[selectedFiles.length - 1]!)
      : this.root;
    const scope = projectRelativePath(this.root, deepestInstructionDirectory) || ".";
    return {
      scope,
      instructions,
      instructionsDigest: digestJson(instructions.map(({ path, scope: instructionScope, digest, truncated }) => ({
        path,
        scope: instructionScope,
        digest,
        truncated,
      }))),
    };
  }
}

async function discoverSelectedInstructionFiles(
  current: string,
  selected: string[],
  budget: { count: number },
): Promise<void> {
  if (budget.count >= MAX_INSTRUCTION_DISCOVERY_ENTRIES) return;
  const instruction = await selectInstructionFile(current);
  if (instruction) selected.push(instruction);

  let directory;
  try {
    directory = await opendir(current);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) return;
    throw error;
  }

  for await (const entry of directory) {
    budget.count += 1;
    if (budget.count > MAX_INSTRUCTION_DISCOVERY_ENTRIES) return;
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_INSTRUCTION_DIRECTORIES.has(entry.name)) continue;
    await discoverSelectedInstructionFiles(join(current, entry.name), selected, budget);
  }
}

async function selectInstructionFile(directory: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) return undefined;
    throw error;
  }

  const fileNames: string[] = [];
  for await (const entry of entries) {
    if (entry.isFile() && !entry.isSymbolicLink() && COMPATIBLE_INSTRUCTION_NAMES.has(entry.name.toLowerCase())) {
      fileNames.push(entry.name);
    }
  }

  for (const exact of EXACT_INSTRUCTION_NAMES) {
    if (fileNames.includes(exact)) return join(directory, exact);
  }
  for (const preferred of EXACT_INSTRUCTION_NAMES) {
    const fallback = fileNames
      .filter((name) => name.toLowerCase() === preferred.toLowerCase())
      .sort((left, right) => left.localeCompare(right))[0];
    if (fallback) return join(directory, fallback);
  }
  return undefined;
}

async function readInstruction(
  root: string,
  path: string,
  remainingBytes: number,
): Promise<DashouProjectInstruction | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const physical = await realpath(path);
    if (!isInside(root, physical)) return undefined;
    const raw = await readFile(physical);
    const included = raw.subarray(0, remainingBytes);
    const truncated = included.length < raw.length;
    let content = included.toString("utf8");
    while (Buffer.byteLength(content, "utf8") > remainingBytes) {
      content = content.slice(0, -1);
    }
    return {
      path: projectRelativePath(root, physical),
      scope: projectRelativePath(root, dirname(physical)) || ".",
      digest: createHash("sha256").update(raw).digest("hex"),
      content,
      truncated,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) return undefined;
    throw error;
  }
}

function directoriesFromRoot(root: string, targetDirectory: string): string[] {
  const relationship = relative(root, targetDirectory);
  if (relationship === "") return [root];
  if (isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${sep}`)) {
    throw new Error("Path is outside the opened project");
  }
  const result = [root];
  let current = root;
  for (const segment of relationship.split(sep)) {
    current = join(current, segment);
    result.push(current);
  }
  return result;
}

function projectRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isInside(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate);
  return relationship === "" || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
