import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DASHOU_V0_TOOLS, createDashouMcpServer } from "./dashou-server.js";
import { DashouWorkspaceRegistry } from "./dashou-workspace.js";

test("Dashou V0 exposes the approved project discovery and coding tools", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...DASHOU_V0_TOOLS].sort());

  const openProject = tools.tools.find((tool) => tool.name === "open_project");
  assert.ok(openProject);
  const input = openProject.inputSchema as { properties?: Record<string, unknown> };
  assert.deepEqual(Object.keys(input.properties ?? {}), ["path"]);
});

test("MCP flow discovers a project, loads its instructions, and edits it", async (t) => {
  const context = await fixture(t);
  const listed = await context.client.callTool({ name: "list_projects", arguments: {} });
  const projects = structured(listed).projects as Array<{ path: string; available: boolean }>;
  assert.deepEqual(projects, [{ name: "project", path: context.project, available: true }]);

  const opened = await context.client.callTool({
    name: "open_project",
    arguments: { path: context.project },
  });
  const openedContent = structured(opened);
  const workspaceId = openedContent.workspaceId as string;
  const contextVersion = openedContent.contextVersion as number;
  assert.equal(contextVersion, 1);
  assert.deepEqual(
    (openedContent.instructions as Array<{ path: string; content: string }>).map(({ path, content }) => ({ path, content })),
    [{ path: "AGENTS.md", content: "Use the project test command before reporting success.\n" }],
  );
  assert.deepEqual(openedContent.availableInstructionFiles, ["src/CLAUDE.md"]);

  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, contextVersion, path: "notes.txt", content: "hello\n" },
  });
  await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      contextVersion,
      path: "notes.txt",
      edits: [{ oldText: "hello", newText: "hello dashou" }],
    },
  });
  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "notes.txt" },
  });
  assert.match(text(read), /hello dashou/);
  assert.equal(await readFile(join(context.project, "notes.txt"), "utf8"), "hello dashou\n");

  const execute = await context.client.callTool({
    name: "execute",
    arguments: { workspaceId, contextVersion, command: "printf ok" },
  });
  assert.equal(structured(execute).exitCode, 0);
  assert.match(text(execute), /ok/);
});

test("MCP context guard delivers nested rules and rejects missing or stale mutation versions", async (t) => {
  const context = await fixture(t);
  const opened = await context.client.callTool({ name: "open_project", arguments: { path: context.project } });
  const workspaceId = structured(opened).workspaceId as string;
  const initialVersion = structured(opened).contextVersion as number;

  const missing = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "missing.txt", content: "must not write\n" },
  });
  assert.equal(missing.isError, true);
  await assert.rejects(() => readFile(join(context.project, "missing.txt")), /ENOENT/);

  const nestedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "src/existing.ts" },
  });
  const nested = structured(nestedRead);
  assert.equal(nested.contextVersion, initialVersion + 1);
  assert.equal((nested.contextUpdate as { reason: string }).reason, "scope_entered");

  const stale = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, contextVersion: initialVersion, path: "stale.txt", content: "must not write\n" },
  });
  assert.equal(stale.isError, true);
  assert.equal(structured(stale).error, "context_refresh_required");
  assert.equal(structured(stale).contextVersion, initialVersion + 1);
  await assert.rejects(() => readFile(join(context.project, "stale.txt")), /ENOENT/);

  const fresh = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      contextVersion: structured(stale).contextVersion,
      path: "fresh.txt",
      content: "written\n",
    },
  });
  assert.equal(fresh.isError, undefined);
  assert.equal(await readFile(join(context.project, "fresh.txt"), "utf8"), "written\n");
});

test("MCP mutations return a structured error when project instructions are truncated", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "AGENTS.md"), "r".repeat(40 * 1024));
  const opened = await context.client.callTool({ name: "open_project", arguments: { path: context.project } });
  const openedContent = structured(opened);
  assert.equal((openedContent.instructions as Array<{ truncated: boolean }>)[0]?.truncated, true);

  const write = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId: openedContent.workspaceId,
      contextVersion: openedContent.contextVersion,
      path: "blocked.txt",
      content: "must not write\n",
    },
  });
  assert.equal(write.isError, true);
  assert.equal(structured(write).error, "instruction_context_too_large");
  assert.equal(structured(write).contextVersion, 1);
  await assert.rejects(() => readFile(join(context.project, "blocked.txt")), /ENOENT/);
});

interface Fixture {
  client: Client;
  project: string;
}
async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dashou-mcp-"));
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "README.md"), "dashou\n");
  await writeFile(join(project, "AGENTS.md"), "Use the project test command before reporting success.\n");
  await writeFile(join(project, "src", "CLAUDE.md"), "Keep source files focused.\n");
  await writeFile(join(project, "src", "existing.ts"), "export {};\n");

  const server = createDashouMcpServer(new DashouWorkspaceRegistry(
    [project],
    { allowProjectCommands: true },
  ));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dashou-test", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, project: await realpath(project) };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content;
  assert.ok(Array.isArray(content));
  return content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
