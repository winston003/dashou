import { createHash, randomBytes } from "node:crypto";

const apiKey = requiredEnv("OPENAI_API_KEY");
const mcpUrl = new URL(requiredEnv("DASHOU_MCP_URL"));
const ownerToken = requiredEnv("DASHOU_MCP_OWNER_TOKEN");
const projectPath = requiredEnv("DASHOU_OPENAI_PROJECT_PATH");
const readPath = process.env.DASHOU_OPENAI_READ_PATH?.trim() || "notes.txt";
const writePath = process.env.DASHOU_OPENAI_WRITE_PATH?.trim() || ".dashou-openai-smoke.txt";
const writeContent = "before from OpenAI MCP smoke\n";
const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6";
const autoApproveMutations = process.env.OPENAI_MCP_AUTO_APPROVE_MUTATIONS === "1";

if (mcpUrl.pathname.replace(/\/+$/, "") !== "/mcp") {
  throw new Error("DASHOU_MCP_URL must point to the Dashou /mcp endpoint");
}
const oauth = await obtainAccessToken(mcpUrl, ownerToken);
const allowedTools = ["list_projects", "open_project", "read", "write", "edit", "execute"];
const tool = {
  type: "mcp",
  server_label: "dashou",
  server_description: "Dashou local project tools explicitly authorized by the user.",
  server_url: mcpUrl.href,
  authorization: oauth.accessToken,
  allowed_tools: allowedTools,
  require_approval: { never: { tool_names: ["list_projects", "open_project", "read"] } },
};

const readResponse = await createResponse({
  model,
  tools: [tool],
  input: `Use Dashou tools, not a prose-only answer. First call list_projects, then open the authorized project at ${projectPath} and read ${readPath}. Report the first line.`,
});
assertToolList(readResponse, allowedTools);
const readCalls = mcpCalls(readResponse);
assert(readCalls.some((call) => call.name === "list_projects"), "OpenAI response did not call list_projects");
assert(readCalls.some((call) => call.name === "open_project"), "OpenAI response did not call open_project");
assert(readCalls.some((call) => call.name === "read"), "OpenAI response did not call read");

const mutation = await continueWithApprovals(readResponse, tool, [
  {
    type: "input_text",
    text: [
      "Continue with the same authorized project and use tools, not prose-only instructions.",
      `Write ${writePath} with exactly this JSON string content: ${JSON.stringify(writeContent)}`,
      `Then edit ${writePath} by replacing ` + JSON.stringify("before from OpenAI MCP smoke") + " with " + JSON.stringify("after from OpenAI MCP smoke") + ".",
      "Finally execute exactly: printf executed-by-openai-mcp-smoke",
      "After all tool calls, summarize the observed results.",
    ].join("\n"),
  },
]);
if (!mutation.completed) {
  console.log(JSON.stringify({
    ok: false,
    evidence: "OpenAI Responses API remote MCP",
    approvalRequired: mutation.approvalRequired,
    nextStep: "Review the approval request, then set OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1 only for a disposable pilot project.",
  }, null, 2));
  process.exitCode = 2;
} else {
  const mutationCalls = mcpCalls(mutation.response);
  for (const name of ["write", "edit", "execute"]) {
    assert(mutationCalls.some((call) => call.name === name), `OpenAI response did not call ${name}`);
  }
  console.log(JSON.stringify({
    ok: true,
    evidence: "OpenAI Responses API remote MCP",
    model,
    serverUrl: mcpUrl.href,
    tools: allowedTools,
    calls: [...new Set([...readCalls, ...mutationCalls].map((call) => call.name))],
    approvalMode: autoApproveMutations ? "mutations auto-approved by explicit env" : "mutation approval required",
    note: "This does not prove ChatGPT UI connectivity or a ChatGPT user task.",
  }, null, 2));
}

async function continueWithApprovals(previous, tool, input) {
  let response = await createResponse({ model, tools: [tool], previous_response_id: previous.id, input });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const approvals = response.output.filter((item) => item.type === "mcp_approval_request");
    if (approvals.length === 0) return { response, completed: true };
    if (!autoApproveMutations) {
      return {
        response,
        completed: false,
        approvalRequired: approvals.map((item) => ({ id: item.id, name: item.name, arguments: item.arguments })),
      };
    }
    const approvalItems = approvals.map((item) => ({
      type: "mcp_approval_response",
      approval_request_id: item.id,
      approve: true,
    }));
    response = await createResponse({
      model,
      tools: [tool],
      previous_response_id: response.id,
      input: approvalItems,
    });
  }
  throw new Error("OpenAI MCP approval loop exceeded five iterations");
}

async function createResponse(body) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`OpenAI Responses API returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function assertToolList(response, expected) {
  const list = response.output.find((item) => item.type === "mcp_list_tools");
  assert(list, "OpenAI response did not contain mcp_list_tools");
  const names = (list.tools ?? []).map((item) => item.name).sort();
  assert(JSON.stringify(names) === JSON.stringify([...expected].sort()), `OpenAI imported tools were ${names.join(", ")}`);
}

function mcpCalls(response) {
  return response.output.filter((item) => item.type === "mcp_call");
}

async function obtainAccessToken(endpoint, token) {
  const base = new URL(endpoint.origin);
  const redirectUri = "http://127.0.0.1/callback";
  const registration = await jsonFetch(new URL("/register", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Dashou OpenAI API Smoke",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "dashou",
    state: "openai-smoke",
    resource: endpoint.href,
  });
  const approval = await fetch(new URL(`/authorize?${params.toString()}`, base), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(params), owner_token: token }),
  });
  if (approval.status !== 302) throw new Error(`Dashou OAuth approval returned HTTP ${approval.status}: ${await approval.text()}`);
  const location = new URL(approval.headers.get("location"));
  const code = location.searchParams.get("code");
  assert(code, "Dashou OAuth approval did not return a code");
  const tokenResponse = await jsonFetch(new URL("/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: endpoint.href,
    }),
  });
  return { accessToken: tokenResponse.access_token };
}

async function jsonFetch(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the OpenAI MCP smoke`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
