import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeAssert from "node:assert/strict";

const repo = new URL("..", import.meta.url).pathname;
const packageJson = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const temp = await mkdtemp(join(tmpdir(), "dashou-pilot-smoke-"));
const installDir = join(temp, "install");
const configDir = join(temp, "config");
const stateDir = join(temp, "state");
const project = join(temp, "project");
const ownerToken = "pilot-smoke-owner-token-123456789";
const port = await freePort();
let serverProcess;

try {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.txt"), "before\n", "utf8");
  const canonicalProject = await realpath(project);
  const packagePath = resolveReleasePackage(repo, packageJson.version);
  assert(packagePath, `final release package is missing: releases/warmbyte-dashou-${packageJson.version}.tgz`);
  const actualPackage = packagePath;
  const tarEntries = execFileSync("tar", ["-tzf", actualPackage], { encoding: "utf8" });
  assert(tarEntries.includes("package/dist/dashou-capabilities.js"), "final package is missing dist/dashou-capabilities.js");
  assert(tarEntries.includes("package/dist/dashou-cli.js"), "final package is missing dist/dashou-cli.js");
  execFileSync("npm", ["install", "--prefix", installDir, actualPackage, "--no-audit", "--no-fund", "--ignore-scripts"], { stdio: "pipe" });

  const cli = join(installDir, "node_modules", ".bin", "dashou");
  const env = {
    ...process.env,
    DASHOU_CONFIG_DIR: configDir,
    DASHOU_STATE_DIR: stateDir,
    DASHOU_ALLOWED_ROOTS: project,
    DASHOU_OAUTH_OWNER_TOKEN: ownerToken,
    DASHOU_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
  };
  const version = execFileSync(cli, ["--version"], { env, encoding: "utf8" }).trim();
  assert(version === packageJson.version, `installed bin returned unexpected version: ${version}`);
  const doctor = execFileSync(cli, ["doctor", "--json"], { env, encoding: "utf8" });
  const doctorReport = JSON.parse(doctor);
  assert(doctorReport.ok === true, `doctor failed: ${doctor}`);
  nodeAssert.deepEqual(doctorReport.capabilities.tools, ["list_projects", "open_project", "read", "write", "edit", "execute"]);

  serverProcess = spawn(cli, ["serve"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  const capabilities = await jsonFetch(`http://127.0.0.1:${port}/capabilities`);
  nodeAssert.deepEqual(capabilities.tools, ["list_projects", "open_project", "read", "write", "edit", "execute"]);

  const client = await oauthClient(`http://127.0.0.1:${port}`, ownerToken);
  const session = await mcpInitialize(client.baseUrl, client.accessToken);
  const tools = await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/list", {});
  nodeAssert.deepEqual((tools.result?.tools ?? []).map((tool) => tool.name).sort(), ["edit", "execute", "list_projects", "open_project", "read", "write"]);

  const listed = await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/call", { name: "list_projects", arguments: {} });
  assert((listed.result?.structuredContent?.projects ?? []).some((entry) => entry.path === canonicalProject && entry.available === true), "list_projects did not return the authorized project");

  const opened = await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/call", { name: "open_project", arguments: { path: project } });
  const workspaceId = opened.result?.structuredContent?.workspaceId;
  assert(typeof workspaceId === "string", "open_project did not return workspaceId");
  const readBefore = await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/call", { name: "read", arguments: { workspaceId, path: "notes.txt" } });
  assert(readBefore.result?.structuredContent?.result === "before\n", "read did not return the local file");
  await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/call", { name: "write", arguments: { workspaceId, path: "created.txt", content: "created by ChatGPT-compatible pilot\n" } });
  await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/call", { name: "edit", arguments: { workspaceId, path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] } });
  const executed = await mcpCall(client.baseUrl, client.accessToken, session.id, "tools/call", { name: "execute", arguments: { workspaceId, command: "printf executed-by-chatgpt-compatible-client" } });
  assert(executed.result?.structuredContent?.stdout === "executed-by-chatgpt-compatible-client", "execute failed");
  nodeAssert.equal(await readFile(join(project, "notes.txt"), "utf8"), "after\n");
  nodeAssert.equal(await readFile(join(project, "created.txt"), "utf8"), "created by ChatGPT-compatible pilot\n");
  console.log(JSON.stringify({ ok: true, install: "fresh npm package install", oauth: "authorization_code", mcp: "Streamable HTTP", tools: ["list_projects", "open_project", "read", "write", "edit", "execute"], operations: ["list_projects", "read", "write", "edit", "execute"], chatgptBoundary: "ChatGPT-compatible MCP client; run real ChatGPT UI acceptance separately" }, null, 2));
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  await rm(temp, { recursive: true, force: true });
}

async function oauthClient(baseUrl, owner) {
  const redirectUri = "http://127.0.0.1/callback";
  const registration = await jsonFetch(`${baseUrl}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT Pilot Smoke", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const verifier = "pilot-smoke-verifier-012345678901234567890123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "dashou", state: "pilot", resource: `${baseUrl}/mcp` });
  const approval = await fetch(`${baseUrl}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(params), owner_token: owner }) });
  assert(approval.status === 302, `OAuth approval failed: ${approval.status}`);
  const location = new URL(approval.headers.get("location"));
  const token = await jsonFetch(`${baseUrl}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, code: location.searchParams.get("code"), code_verifier: verifier, redirect_uri: redirectUri, resource: `${baseUrl}/mcp` }) });
  return { baseUrl, accessToken: token.access_token };
}

async function mcpInitialize(baseUrl, accessToken) {
  const response = await mcpRequest(baseUrl, accessToken, undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "chatgpt-pilot-smoke", version: "1.0.0" } } });
  const sessionId = response.headers.get("mcp-session-id");
  assert(sessionId, "MCP initialize did not return a session");
  await mcpRequest(baseUrl, accessToken, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  return { id: sessionId };
}

async function mcpCall(baseUrl, accessToken, sessionId, method, params) {
  return await responseJson(await mcpRequest(baseUrl, accessToken, sessionId, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1_000_000), method, params }));
}

async function mcpRequest(baseUrl, accessToken, sessionId, body) {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function responseJson(response) {
  if (!response.ok) throw new Error(`MCP request failed: ${response.status} ${await response.text()}`);
  const body = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("application/json")) return JSON.parse(body);
  const line = body.split("\n").find((entry) => entry.startsWith("data: "));
  assert(line, `MCP response had no JSON payload: ${body}`);
  return JSON.parse(line.slice(6));
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${await response.text()}`);
  return await response.json();
}

async function waitForHealth(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function resolveReleasePackage(root, version) {
  const path = join(root, "releases", `warmbyte-dashou-${version}.tgz`);
  try {
    execFileSync("test", ["-f", path]);
    return path;
  } catch {
    return undefined;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
