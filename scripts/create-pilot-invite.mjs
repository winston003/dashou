#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const args = process.argv.slice(2);
const interactive = args[0] === "--interactive" || (args.length === 0 && input.isTTY);
const explicitOutput = args.find((value) => value !== "--interactive");

if (interactive) {
  await runInteractive(explicitOutput);
} else {
  createInvite({
    outputPath: explicitOutput || "dashou-invite.json",
    publicBaseUrl: requiredEnv("DASHOU_INVITE_PUBLIC_URL"),
    pilotToken: requiredEnv("DASHOU_INVITE_PILOT_TOKEN"),
    tunnelToken: process.env.DASHOU_INVITE_TUNNEL_TOKEN?.trim(),
  });
}

async function runInteractive(explicitOutput) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("交互式邀请向导需要在终端中运行；非交互环境请使用 DASHOU_INVITE_* 环境变量");
  }

  const rl = createInterface({ input, output });
  try {
    console.log("搭手内测邀请向导");
    console.log("只需要准备公网地址和该用户专用 Tunnel Token；授权 token 会自动创建或安全读取。");
    console.log("");

    const accountId = await requiredQuestion(rl, "用户标识（如 alice）：");
    const publicBaseUrl = process.env.DASHOU_INVITE_PUBLIC_URL?.trim()
      || await requiredQuestion(rl, "公网地址（https://...）：");
    const tunnelToken = process.env.DASHOU_INVITE_TUNNEL_TOKEN?.trim()
      || await secretQuestion(rl, "Tunnel Token（可留空）：");
    const defaultOutput = resolve("releases", "invites", safeFileName(accountId) + ".dashou-invite.json");
    const outputPath = explicitOutput || defaultOutput;
    validatePublicUrl(publicBaseUrl);
    if (existsSync(resolve(outputPath))) throw new Error("Refusing to overwrite existing invite: " + resolve(outputPath));

    let pilotToken = process.env.DASHOU_INVITE_PILOT_TOKEN?.trim();
    let expiresAt;
    if (!pilotToken && process.env.DASHOU_PILOT_CONTROL_URL && process.env.DASHOU_PILOT_CONTROL_ADMIN_TOKEN) {
      expiresAt = process.env.DASHOU_INVITE_EXPIRES_AT?.trim()
        || new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
      const created = await createPilotAccount(accountId, expiresAt);
      pilotToken = created.token;
    }
    if (!pilotToken) {
      pilotToken = await secretQuestion(rl, "内测授权 token：");
    }
    if (pilotToken.length < 16) throw new Error("内测授权 token 至少需要 16 个字符");

    createInvite({ outputPath, publicBaseUrl, pilotToken, tunnelToken: tunnelToken || undefined });
    console.log("已生成管理员邀请：" + resolve(outputPath));
    if (expiresAt) console.log("内测账号有效期：" + expiresAt);
    console.log("请把这一个 .dashou-invite.json 文件发给对应用户；不要把 token 复制到聊天或文档。");
  } finally {
    rl.close();
  }
}

function createInvite({ outputPath, publicBaseUrl, pilotToken, tunnelToken }) {
  const target = resolve(outputPath);
  if (existsSync(target)) throw new Error("Refusing to overwrite existing invite: " + target);
  const parsedUrl = validatePublicUrl(publicBaseUrl);
  if (pilotToken.length < 16) throw new Error("DASHOU_INVITE_PILOT_TOKEN must be at least 16 characters long");

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(
    target,
    JSON.stringify({
      kind: "dashou-invite",
      version: 1,
      publicBaseUrl: parsedUrl.toString().replace(/\/$/, ""),
      pilotToken,
      ...(tunnelToken ? { tunnelToken } : {}),
    }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({
    path: target,
    publicBaseUrl: parsedUrl.toString().replace(/\/$/, ""),
    hasPilotToken: true,
    hasTunnelToken: Boolean(tunnelToken),
    mode: "0600",
  }));
}

function validatePublicUrl(publicBaseUrl) {
  const parsedUrl = new URL(publicBaseUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("DASHOU_INVITE_PUBLIC_URL must use https");
  return parsedUrl;
}

async function createPilotAccount(accountId, expiresAt) {
  const baseUrl = requiredUrl(process.env.DASHOU_PILOT_CONTROL_URL, "DASHOU_PILOT_CONTROL_URL");
  const adminToken = requiredEnv("DASHOU_PILOT_CONTROL_ADMIN_TOKEN");
  const response = await fetch(new URL("/admin/pilot/accounts", baseUrl), {
    method: "POST",
    headers: {
      authorization: "Bearer " + adminToken,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ accountId, expiresAt }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { response: text };
  }
  if (!response.ok) throw new Error("Pilot control returned HTTP " + response.status);
  if (typeof payload?.token !== "string" || payload.token.length < 16) {
    throw new Error("Pilot control did not return a valid user token");
  }
  return payload;
}

async function questionWithDefault(rl, label, fallback) {
  const answer = (await rl.question(label + " [" + fallback + "]: ")).trim();
  return answer || fallback;
}

async function requiredQuestion(rl, label) {
  const answer = (await rl.question(label)).trim();
  if (!answer) throw new Error("该项不能为空");
  return answer;
}

async function secretQuestion(rl, label) {
  if (!input.isTTY || !output.isTTY) return (await rl.question(label)).trim();
  rl.pause();
  output.write(label);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolveSecret, rejectSecret) => {
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") {
          cleanup();
          rejectSecret(new Error("已取消"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolveSecret(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    const cleanup = () => {
      input.setRawMode(false);
      input.removeListener("data", onData);
      output.write("\n");
      rl.resume();
    };
    input.on("data", onData);
  });
}

function safeFileName(value) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pilot-user";
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

function requiredUrl(value, name) {
  const text = value?.trim() || requiredEnv(name);
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(name + " must use http or https");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(name + " must use https outside localhost/127.0.0.1");
  }
  return url;
}
