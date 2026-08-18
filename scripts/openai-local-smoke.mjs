#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const apiKey = requiredEnv("OPENAI_API_KEY");
const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6";
const autoApproveMutations = process.env.OPENAI_MCP_AUTO_APPROVE_MUTATIONS === "1";
if (!autoApproveMutations) {
  throw new Error("Set OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1 for the disposable temporary project used by this smoke");
}
const repo = new URL("..", import.meta.url).pathname;
const packageJson = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const root = await mkdtemp(join(tmpdir(), "dashou-openai-local-smoke-"));
const project = join(root, "project");
const installDir = join(root, "install");
const configDir = join(root, "config");
const stateDir = join(root, "state");
const ownerToken = randomBytes(32).toString("base64url");
const port = await freePort();
let dashouProcess;
let tunnelProcess;

try {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.txt"), "before from OpenAI local smoke\n", "utf8");

  const packagePath = join(repo, "releases", `warmbyte-dashou-${packageJson.version}.tgz`);
  execFileSync("test", ["-f", packagePath]);
  const tarEntries = execFileSync("tar", ["-tzf", packagePath], { encoding: "utf8" });
  assert(tarEntries.includes("package/dist/dashou-capabilities.js"), "final package is missing dist/dashou-capabilities.js");
  execFileSync("npm", ["install", "--prefix", installDir, packagePath, "--no-audit", "--no-fund", "--ignore-scripts"], { stdio: "pipe" });

  const cli = join(installDir, "node_modules", ".bin", "dashou");
  const tunnelOutputRef = { value: "" };
  tunnelProcess = spawn("cloudflared", [
    "tunnel", "--no-autoupdate", "--protocol", "http2", "--loglevel", "info",
    "--url", `http://127.0.0.1:${port}`,
  ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const tunnelOutput = collectOutput(tunnelProcess, tunnelOutputRef);
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
  const doctor = JSON.parse(execFileSync(cli, ["doctor", "--json"], { env, encoding: "utf8" }));
  assert(doctor.ok === true, `installed Dashou doctor failed: ${JSON.stringify(doctor)}`);
  assert(JSON.stringify(doctor.capabilities?.tools) === JSON.stringify(["list_projects", "open_project", "read", "write", "edit", "execute"]), "installed package did not report the six-tool contract");

  const dashouOutputRef = { value: "" };
  dashouProcess = spawn(cli, ["serve"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  collectOutput(dashouProcess, dashouOutputRef);
  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  await waitForHealth(`${publicUrl}/healthz`, () => `${dashouOutputRef.value}\n${tunnelOutputRef.value}`);

  const oauth = await obtainAccessToken(new URL(`${publicUrl}/mcp`), ownerToken);
  const allowedTools = ["list_projects", "open_project", "read", "write", "edit", "execute"];
  const tool = {
    type: "mcp",
    server_label: "dashou",
    server_description: "Dashou local project tools explicitly authorized by the user.",
    server_url: `${publicUrl}/mcp`,
    authorization: oauth.accessToken,
    allowed_tools: allowedTools,
    require_approval: { never: { tool_names: ["list_projects", "open_project", "read"] } },
  };

  const readResponse = await createResponse({
    model,
    tools: [tool],
    input: `Use Dashou tools, not prose-only instructions. First call list_projects, then open the authorized project at ${project} and read notes.txt. Report its first line exactly.`,
  });
  assertToolList(readResponse, allowedTools);
  const readCalls = mcpCalls(readResponse);
  assertCompletedCall(readCalls, "list_projects");
  assertCompletedCall(readCalls, "open_project");
  assertCompletedCall(readCalls, "read");

  const mutationResponse = await createResponse({
    model,
    tools: [tool],
    previous_response_id: readResponse.id,
    input: [{
      type: "input_text",
      text: [
        "Continue with the same authorized project and use Dashou tools, not prose-only instructions.",
        `Write .dashou-openai-smoke.txt with exactly this JSON string content: ${JSON.stringify("before from OpenAI local smoke\n")}`,
        "Then edit that file by replacing before from OpenAI local smoke with after from OpenAI local smoke.",
        "Finally execute exactly: printf executed-by-openai-local-smoke",
        "After all tool calls, briefly summarize the observed results.",
      ].join("\n"),
    }],
  });
  const mutationResult = await approveUntilComplete(mutationResponse, tool);
  const mutationCalls = mutationResult.calls;
  for (const name of ["write", "edit", "execute"]) assertCompletedCall(mutationCalls, name);

  const finalText = await readFile(join(project, ".dashou-openai-smoke.txt"), "utf8");
  assert(finalText === "after from OpenAI local smoke\n", `unexpected final file content: ${JSON.stringify(finalText)}`);
  assert(mutationCalls.some((call) => JSON.stringify(call).includes("executed-by-openai-local-smoke")), "execute output was not observed in the model tool calls");

  console.log(JSON.stringify({
    ok: true,
    evidence: "OpenAI Responses API remote MCP",
    install: "fresh npm package install",
    ingress: "ephemeral Cloudflare Quick Tunnel",
    model,
    tools: allowedTools,
    message: "model sent a read request and continued with text mutation and execute instructions",
    calls: [...new Set([...readCalls, ...mutationCalls].map((call) => call.name))],
    project: "temporary disposable directory",
    chatgptBoundary: "This proves the OpenAI API MCP path, not ChatGPT UI or a real customer task.",
  }, null, 2));
} finally {
  await stopProcess(dashouProcess);
  await stopProcess(tunnelProcess);
  await rm(root, { recursive: true, force: true });
}

async function approveUntilComplete(response, tool) {
  let current = response;
  const calls = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.push(...mcpCalls(current));
    const approvals = current.output.filter((item) => item.type === "mcp_approval_request");
    if (approvals.length === 0) return { response: current, calls };
    current = await createResponse({
      model,
      tools: [tool],
      previous_response_id: current.id,
      input: approvals.map((item) => ({
        type: "mcp_approval_response",
        approval_request_id: item.id,
        approve: true,
      })),
    });
  }
  throw new Error("OpenAI MCP approval loop exceeded six iterations");
}

async function createResponse(body) {
  const response = curlRequest("POST", "https://api.openai.com/v1/responses", JSON.stringify(body), {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  }, 180);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`OpenAI Responses API returned HTTP ${response.status}: ${response.body}`);
  }
  return JSON.parse(response.body);
}

async function obtainAccessToken(endpoint, owner) {
  const base = new URL(endpoint.origin);
  const redirectUri = "http://127.0.0.1/callback";
  const registration = await jsonFetch(new URL("/register", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Dashou OpenAI local smoke", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "dashou", state: "openai-local-smoke", resource: endpoint.href });
  const approval = curlRequest("POST", new URL(`/authorize?${params.toString()}`, base).href,
    new URLSearchParams({ ...Object.fromEntries(params), owner_token: owner }).toString(),
    { "content-type": "application/x-www-form-urlencoded" }, 30);
  if (approval.status !== 302) throw new Error(`Dashou OAuth approval returned HTTP ${approval.status}: ${approval.body}`);
  const code = new URL(approval.headers.location).searchParams.get("code");
  assert(code, "Dashou OAuth approval did not return a code");
  const token = await jsonFetch(new URL("/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, code, code_verifier: verifier, redirect_uri: redirectUri, resource: endpoint.href }),
  });
  return { accessToken: token.access_token };
}

function assertToolList(response, expected) {
  const list = response.output.find((item) => item.type === "mcp_list_tools");
  assert(list, "OpenAI response did not contain mcp_list_tools");
  const names = (list.tools ?? []).map((item) => item.name).sort();
  assert(JSON.stringify(names) === JSON.stringify([...expected].sort()), `OpenAI imported tools were ${names.join(", ")}`);
}

function assertCompletedCall(calls, name) {
  const call = calls.find((item) => item.name === name);
  assert(call, `OpenAI response did not call ${name}`);
  assert(!call.error, `OpenAI MCP ${name} failed: ${call.error}`);
  if (call.status !== undefined) assert(call.status === "completed", `OpenAI MCP ${name} status was ${call.status}`);
}

function mcpCalls(response) {
  return response.output.filter((item) => item.type === "mcp_call");
}

async function jsonFetch(url, options) {
  const headers = options?.headers ?? {};
  const body = options?.body === undefined
    ? undefined
    : typeof options.body === "string"
      ? options.body
      : options.body instanceof URLSearchParams
        ? options.body.toString()
        : JSON.stringify(options.body);
  const response = curlRequest(options?.method ?? "GET", String(url), body, headers, 30);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${url} returned HTTP ${response.status}: ${response.body}`);
  }
  return JSON.parse(response.body);
}

async function waitForHealth(url, diagnostics = () => "") {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = curlRequest("GET", url, undefined, {}, 5);
      if (response.status >= 200 && response.status < 300) return;
    } catch {
      // The daemon or tunnel is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}\n${diagnostics()}`);
}

function curlRequest(method, url, body, headers = {}, timeoutSeconds = 30) {
  const args = ["-sS", "--max-time", String(timeoutSeconds), "-X", method, url, "-D", "-"];
  for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
  if (body !== undefined) args.push("--data", body);
  const output = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const separator = "\r\n\r\n";
  const blocks = output.split(separator);
  const headerText = blocks.length > 1 ? blocks.at(-2) ?? "" : output;
  const bodyText = blocks.length > 1 ? blocks.at(-1) ?? "" : "";
  const statusMatches = [...headerText.matchAll(/HTTP\/\S+\s+(\d{3})/gu)];
  const status = Number(statusMatches.at(-1)?.[1] ?? 0);
  const parsedHeaders = {};
  for (const line of headerText.split(/\r?\n/u).slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) parsedHeaders[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return { status, headers: parsedHeaders, body: bodyText };
}

async function waitForPublicUrl(readOutput) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const match = readOutput().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`cloudflared did not provide a Quick Tunnel URL. Output: ${readOutput().slice(-4_000)}`);
}

function collectOutput(child, ref = { value: "" }) {
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; ref.value = output; });
  child.stderr?.on("data", (chunk) => { output += chunk; ref.value = output; });
  return () => output;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
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

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the local OpenAI MCP smoke`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
