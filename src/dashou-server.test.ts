import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DASHOU_V0_TOOLS, createDashouMcpServer } from "./dashou-server.js";
import { DashouWorkspaceRegistry } from "./dashou-workspace.js";

test("Dashou V0 exposes exactly five tools", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...DASHOU_V0_TOOLS].sort());

  const openProject = tools.tools.find((tool) => tool.name === "open_project");
  assert.ok(openProject);
  const input = openProject.inputSchema as { properties?: Record<string, unknown> };
  assert.deepEqual(Object.keys(input.properties ?? {}), ["path"]);
});

test("five-tool MCP flow can edit a real local project", async (t) => {
  const context = await fixture(t);
  const opened = await context.client.callTool({
    name: "open_project",
    arguments: { path: context.project },
  });
  const workspaceId = structured(opened).workspaceId as string;

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

interface Fixture {
  client: Client;
  project: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dashou-mcp-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "dashou\n");

  const server = createDashouMcpServer(new DashouWorkspaceRegistry([root]));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dashou-test", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, project };
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
