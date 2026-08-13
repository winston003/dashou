#!/usr/bin/env node

const baseUrl = requiredUrl(process.env.DASHOU_PILOT_CONTROL_URL, "DASHOU_PILOT_CONTROL_URL");
const adminToken = requiredEnv("DASHOU_PILOT_CONTROL_ADMIN_TOKEN");
const [command, accountId, value] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") {
  console.log([
    "用法：",
    "  npm run pilot:admin -- list",
    "  npm run pilot:admin -- create <accountId> <expiresAt>",
    "  npm run pilot:admin -- enable <accountId>",
    "  npm run pilot:admin -- disable <accountId>",
    "  npm run pilot:admin -- expire <accountId> <expiresAt>",
    "  npm run pilot:admin -- revoke <accountId>",
    "",
    "管理员 token 只从 DASHOU_PILOT_CONTROL_ADMIN_TOKEN 环境变量读取。",
  ].join("\n"));
  process.exit(0);
}

const headers = {
  authorization: `Bearer ${adminToken}`,
  accept: "application/json",
  "content-type": "application/json",
};

if (command === "list") {
  await call("GET", "/admin/pilot/accounts");
} else if (command === "create") {
  requireArgument(accountId, "accountId");
  requireArgument(value, "expiresAt");
  await call("POST", "/admin/pilot/accounts", { accountId, expiresAt: value });
} else if (["enable", "disable", "revoke", "expire"].includes(command)) {
  requireArgument(accountId, "accountId");
  const body = command === "enable"
    ? { enabled: true }
    : command === "disable"
      ? { enabled: false }
      : command === "revoke"
        ? { revoke: true }
        : { expiresAt: requiredArgument(value, "expiresAt") };
  await call("POST", `/admin/pilot/accounts/${encodeURIComponent(accountId)}`, body);
} else {
  throw new Error(`未知命令：${command}`);
}

async function call(method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { response: text };
  }
  if (!response.ok) throw new Error(`Pilot control returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  console.log(JSON.stringify(payload, null, 2));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(value, name) {
  const text = requiredEnv(name);
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must use http or https`);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must use https outside localhost/127.0.0.1`);
  }
  return url;
}

function requireArgument(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredArgument(value, name) {
  return requireArgument(value, name);
}
