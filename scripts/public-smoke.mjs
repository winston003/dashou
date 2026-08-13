#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const root = await mkdtemp(join(tmpdir(), "dashou-public-smoke-"));
const project = join(root, "project");
const configDir = join(root, "config");
const stateDir = join(root, "state");
const ownerToken = randomBytes(32).toString("base64url");
const port = await freePort();
let dashouProcess;
let tunnelProcess;

try {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.txt"), "before public smoke\n", "utf8");

  tunnelProcess = spawn("cloudflared", [
    "tunnel", "--no-autoupdate", "--protocol", "http2", "--loglevel", "info",
    "--url", `http://127.0.0.1:${port}`,
  ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const tunnelOutput = collectOutput(tunnelProcess);
  const publicUrl = await waitForPublicUrl(tunnelOutput);

  const env = {
    ...process.env,
    DASHOU_CONFIG_DIR: configDir,
    DASHOU_STATE_DIR: stateDir,
    DASHOU_ALLOWED_ROOTS: root,
    DASHOU_OAUTH_OWNER_TOKEN: ownerToken,
    DASHOU_PUBLIC_BASE_URL: publicUrl,
    DASHOU_TRUST_PROXY: "1",
    PORT: String(port),
  };
  dashouProcess = spawn(process.execPath, ["dist/dashou-cli.js", "serve"], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  await waitForHealth(`${publicUrl}/healthz`);
  const health = await jsonRequest("GET", `${publicUrl}/healthz`);
  const capabilities = await jsonRequest("GET", `${publicUrl}/capabilities`);
  assert(health.ok === true && health.version, "public health check failed");
  assert(JSON.stringify(capabilities.tools) === JSON.stringify(["open_project", "read", "write", "edit", "execute"]), "public capabilities are not the five-tool contract");

  const oauthClient = await registerClient(publicUrl);
  const accessToken = await authorize(publicUrl, oauthClient, ownerToken);
  const sessionId = await initializeMcp(publicUrl, accessToken);
  const tools = await mcpCall(publicUrl, accessToken, sessionId, "tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name).sort();
  assert(JSON.stringify(toolNames) === JSON.stringify(["edit", "execute", "open_project", "read", "write"]), "public MCP tools are not the five-tool contract");

  const opened = await mcpCall(publicUrl, accessToken, sessionId, "tools/call", {
    name: "open_project",
    arguments: { path: project },
  });
  const workspaceId = opened.result?.structuredContent?.workspaceId;
  assert(typeof workspaceId === "string", "public open_project did not return workspaceId");

  const before = await mcpCall(publicUrl, accessToken, sessionId, "tools/call", {
    name: "read",
    arguments: { workspaceId, path: "notes.txt" },
  });
  assert(before.result?.structuredContent?.result === "before public smoke\n", "public read did not return the local file");

  await mcpCall(publicUrl, accessToken, sessionId, "tools/call", {
    name: "write",
    arguments: { workspaceId, path: "created.txt", content: "created public smoke\n" },
  });
  await mcpCall(publicUrl, accessToken, sessionId, "tools/call", {
    name: "edit",
    arguments: { workspaceId, path: "notes.txt", edits: [{ oldText: "before public smoke", newText: "after public smoke" }] },
  });
  const executed = await mcpCall(publicUrl, accessToken, sessionId, "tools/call", {
    name: "execute",
    arguments: { workspaceId, command: "printf public-executed" },
  });
  assert(executed.result?.structuredContent?.stdout === "public-executed", "public execute did not return expected stdout");
  assert(await readFile(join(project, "notes.txt"), "utf8") === "after public smoke\n", "public edit did not change the local file");
  assert(await readFile(join(project, "created.txt"), "utf8") === "created public smoke\n", "public write did not create the local file");

  console.log(JSON.stringify({
    ok: true,
    evidence: "ephemeral Cloudflare Quick Tunnel",
    publicUrl,
    oauth: "authorization_code",
    mcp: "Streamable HTTP",
    tools: toolNames,
    operations: ["read", "write", "edit", "execute"],
    trustProxy: true,
    chatgptBoundary: "This proves a public ChatGPT-compatible MCP client path, not the ChatGPT UI or a real user task.",
  }, null, 2));
} finally {
  await stopProcess(tunnelProcess);
  await stopProcess(dashouProcess);
  await rm(root, { recursive: true, force: true });
}

async function registerClient(baseUrl) {
  return jsonRequest("POST", `${baseUrl}/register`, {
    client_name: "Dashou public smoke",
    redirect_uris: ["http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

async function authorize(baseUrl, client, owner) {
  const redirectUri = "http://127.0.0.1/callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "dashou",
    state: "public-smoke",
    resource: `${baseUrl}/mcp`,
    owner_token: owner,
  });
  const response = await curlRequest("POST", `${baseUrl}/authorize`, params.toString(), {
    "content-type": "application/x-www-form-urlencoded",
  }, true);
  assert(response.status === 302, `public OAuth authorization returned HTTP ${response.status}`);
  const code = new URL(response.headers.location).searchParams.get("code");
  assert(code, "public OAuth authorization did not return a code");
  const token = await jsonRequest("POST", `${baseUrl}/token`, new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: `${baseUrl}/mcp`,
  }).toString(), { "content-type": "application/x-www-form-urlencoded" });
  return token.access_token;
}

async function initializeMcp(baseUrl, accessToken) {
  const response = await curlRequest("POST", `${baseUrl}/mcp`, JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "dashou-public-smoke", version: "1.0.0" },
    },
  }), {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }, true);
  assert(response.status === 200, `public MCP initialize returned HTTP ${response.status}`);
  const sessionId = response.headers["mcp-session-id"];
  assert(sessionId, "public MCP initialize did not return a session");
  await curlRequest("POST", `${baseUrl}/mcp`, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  }, true);
  return sessionId;
}

async function mcpCall(baseUrl, accessToken, sessionId, method, params) {
  const response = await curlRequest("POST", `${baseUrl}/mcp`, JSON.stringify({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000),
    method,
    params,
  }), {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  }, true);
  assert(response.status === 200, `public MCP ${method} returned HTTP ${response.status}`);
  const dataLine = response.body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : response.body);
}

async function jsonRequest(method, url, body, headers = {}) {
  const serializedBody = body === undefined
    ? undefined
    : typeof body === "string"
      ? body
      : body instanceof URLSearchParams
        ? body.toString()
        : JSON.stringify(body);
  const requestHeaders = Object.keys(headers).length > 0
    ? headers
    : body === undefined || typeof body === "string" || body instanceof URLSearchParams
      ? {}
      : { "content-type": "application/json" };
  const response = await curlRequest(method, url, serializedBody, requestHeaders, true);
  assert(response.status >= 200 && response.status < 300, `${url} returned HTTP ${response.status}: ${response.body}`);
  return JSON.parse(response.body);
}

async function curlRequest(method, url, body, headers = {}, includeHeaders = false) {
  const args = ["-sS", "--max-time", "30", "-X", method, url];
  if (includeHeaders) args.push("-D", "-");
  for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
  if (body !== undefined) args.push("--data", body);
  const output = execFileSync("curl", args, { encoding: "utf8" });
  if (!includeHeaders) return { status: 200, headers: {}, body: output };
  const blocks = output.split("\r\n\r\n");
  const headerText = blocks.length > 1 ? blocks.at(-2) : output;
  const bodyText = blocks.length > 1 ? blocks.at(-1) : "";
  const lines = headerText.split(/\r?\n/);
  const statusMatches = [...headerText.matchAll(/HTTP\/\S+\s+(\d{3})/g)];
  const status = Number(statusMatches.at(-1)?.[1] ?? 0);
  const parsedHeaders = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) parsedHeaders[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return { status, headers: parsedHeaders, body: bodyText };
}

function collectOutput(child) {
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  return () => output;
}

async function waitForPublicUrl(readOutput) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const match = readOutput().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`cloudflared did not provide a Quick Tunnel URL. Output: ${readOutput().slice(-4_000)}`);
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await curlRequest("GET", url, undefined, {}, true);
      if (response.status === 200) return;
    } catch {
      // The local server or tunnel is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
