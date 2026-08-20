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
  assert.deepEqual(openedContent.instructions, [{
    path: "AGENTS.md",
    content: "Use the project test command before reporting success.\n",
  }]);
  assert.deepEqual(openedContent.availableInstructionFiles, ["src/CLAUDE.md"]);

  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "notes.txt", content: "hello\n" },
  });
  await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
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
    arguments: { workspaceId, command: "printf ok" },
  });
  assert.equal(structured(execute).exitCode, 0);
  assert.match(text(execute), /ok/);
});

test("tool observer separates successful calls from categorized failures", async (t) => {
  const outcomes: Array<{ outcome: "ok" | "error"; errorCode?: string }> = [];
  const context = await fixture(t, (outcome, errorCode) => {
    outcomes.push({ outcome, ...(errorCode ? { errorCode } : {}) });
  });
  await context.client.callTool({ name: "list_projects", arguments: {} });
  const failed = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: "missing", path: "README.md" },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(outcomes, [
    { outcome: "ok" },
    { outcome: "error", errorCode: "PROJECT_NOT_OPEN" },
  ]);
});

interface Fixture {
  client: Client;
  project: string;
}
async function fixture(
  t: TestContext,
  observer?: (outcome: "ok" | "error", errorCode?: string) => Promise<void> | void,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dashou-mcp-"));
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "README.md"), "dashou\n");
  await writeFile(join(project, "AGENTS.md"), "Use the project test command before reporting success.\n");
  await writeFile(join(project, "src", "CLAUDE.md"), "Keep source files focused.\n");

  const server = createDashouMcpServer(new DashouWorkspaceRegistry(
    [project],
    { allowProjectCommands: true },
  ), observer);
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
