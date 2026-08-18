import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { closeHttpServer, createDashouServer } from "./dashou-server.js";
import type { DashouConfig } from "./dashou-config.js";
import { dashouVersion } from "./dashou-capabilities.js";

test("HTTP server exposes health and OAuth discovery and protects MCP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dashou-http-"));
  const project = join(root, "project");
  await mkdir(project);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: DashouConfig = {
    host: "127.0.0.1",
    port,
    allowedRoots: [root],
    allowedHosts: ["127.0.0.1", "localhost"],
    publicBaseUrl: baseUrl,
    stateDir: join(root, ".state"),
    trustProxy: false,
    oauth: {
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["dashou"],
      allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
    },
  };
  const running = createDashouServer(config);
  assert.equal(running.app.get("trust proxy"), false);
  const httpServer = running.app.listen(port, config.host);
  t.after(async () => {
    await closeHttpServer(httpServer, running.close);
    await rm(root, { recursive: true, force: true });
  });

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    name: "dashou",
    version: dashouVersion(),
    pilot: { allowed: true, reason: "enabled" },
  });

  const capabilities = await fetch(`${baseUrl}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    name: "dashou",
    version: dashouVersion(),
    protocol: "streamable-http",
    oauth: true,
    tools: ["list_projects", "open_project", "read", "write", "edit", "execute"],
  });

  const protectedMetadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedMetadata.status, 200);
  const protectedJson = await protectedMetadata.json() as { resource?: string; authorization_servers?: string[] };
  assert.equal(protectedJson.resource, `${baseUrl}/mcp`);
  assert.deepEqual(protectedJson.authorization_servers, [`${baseUrl}/`]);

  const authMetadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authMetadata.status, 200);
  const authJson = await authMetadata.json() as { registration_endpoint?: string; authorization_endpoint?: string };
  assert.equal(authJson.registration_endpoint, `${baseUrl}/register`);
  assert.equal(authJson.authorization_endpoint, `${baseUrl}/authorize`);

  const unauthenticated = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /resource_metadata=/);

  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT Test",
      redirect_uris: ["https://chatgpt.com/aip/test/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { client_id?: string };
  assert.match(registered.client_id ?? "", /^dashou-/);
});

test("OAuth + Streamable HTTP works end to end like a remote MCP host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dashou-http-e2e-"));
  const project = join(root, "project");
  await mkdir(project);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: DashouConfig = {
    host: "127.0.0.1",
    port,
    allowedRoots: [root],
    allowedHosts: ["127.0.0.1", "localhost"],
    publicBaseUrl: baseUrl,
    stateDir: join(root, ".state"),
    trustProxy: false,
    oauth: {
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["dashou"],
      allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
    },
  };
  const running = createDashouServer(config);
  const httpServer = running.app.listen(port, config.host);
  t.after(async () => {
    await closeHttpServer(httpServer, running.close);
    await rm(root, { recursive: true, force: true });
  });

  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT E2E",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json() as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "dashou",
    state: "e2e",
    resource: `${baseUrl}/mcp`,
  });
  const authorizePage = await fetch(`${baseUrl}/authorize?${authorizeParams}`);
  assert.equal(authorizePage.status, 200);
  assert.match(await authorizePage.text(), /连接搭手/);

  const approval = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...Object.fromEntries(authorizeParams),
      owner_token: config.oauth.ownerToken,
    }),
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location") ?? "");
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get("state"), "e2e");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: `${baseUrl}/mcp`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json() as { access_token: string; refresh_token: string };
  assert.ok(token.access_token);
  assert.ok(token.refresh_token);

  const commonHeaders = {
    authorization: `Bearer ${token.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "chatgpt-e2e", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initialize.status, 200);
  const initPayload = await rpcPayload(initialize);
  assert.equal((initPayload.result as { serverInfo?: { name?: string } })?.serverInfo?.name, "dashou");
  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId);

  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...commonHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  const toolsResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...commonHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(toolsResponse.status, 200);
  const toolsPayload = await rpcPayload(toolsResponse);
  const tools = (toolsPayload.result as { tools?: Array<{ name: string }> })?.tools ?? [];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["edit", "execute", "list_projects", "open_project", "read", "write"]);

  const openedResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...commonHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "open_project", arguments: { path: project } },
    }),
  });
  assert.equal(openedResponse.status, 200);
  const openedPayload = await rpcPayload(openedResponse);
  const workspaceId = (openedPayload.result as { structuredContent?: { workspaceId?: string } })?.structuredContent?.workspaceId;
  assert.ok(workspaceId);

});

test("shutdown closes an active Streamable HTTP SSE connection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dashou-http-sse-shutdown-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: DashouConfig = {
    host: "127.0.0.1",
    port,
    allowedRoots: [root],
    allowedHosts: ["127.0.0.1", "localhost"],
    publicBaseUrl: baseUrl,
    stateDir: join(root, ".state"),
    trustProxy: false,
    oauth: {
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["dashou"],
      allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
    },
  };
  const running = createDashouServer(config);
  const httpServer = running.app.listen(port, config.host);
  t.after(async () => {
    await closeHttpServer(httpServer, running.close);
    await rm(root, { recursive: true, force: true });
  });

  const { accessToken, sessionId } = await establishSession(baseUrl, config.oauth.ownerToken);
  const sse = await fetch(`${baseUrl}/mcp`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = sse.body?.getReader();
  assert.ok(reader);

  const pendingRead = reader.read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const shutdown = closeHttpServer(httpServer, running.close);
  const shutdownResult = await Promise.race([
    shutdown.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
  ]);
  assert.equal(shutdownResult, "closed");
  const finalRead = await Promise.race([
    pendingRead,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE stream did not close")), 2_000)),
  ]);
  assert.equal(finalRead.done, true);
});

async function establishSession(baseUrl: string, ownerToken: string): Promise<{ accessToken: string; sessionId: string }> {
  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "SSE shutdown test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const { client_id: clientId } = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "dashou",
    resource: `${baseUrl}/mcp`,
  });
  const approval = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(params), owner_token: ownerToken }),
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location") ?? "");
  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: callback.searchParams.get("code") ?? "",
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: `${baseUrl}/mcp`,
    }),
  });
  const { access_token: accessToken } = await tokenResponse.json() as { access_token: string };
  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "sse-test", version: "1.0.0" } },
    }),
  });
  assert.equal(initialize.status, 200);
  assert.ok(await initialize.text());
  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId);
  return { accessToken, sessionId };
}
async function rpcPayload(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(body) as Record<string, unknown>;
  }
  const dataLine = body
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No JSON-RPC payload in response: ${body}`);
  return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
