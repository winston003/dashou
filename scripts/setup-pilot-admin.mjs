#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PILOT_CONTROL_URL,
  writePilotAdminConfig,
} from "./pilot-admin-config.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "搭手管理员初始化",
    "",
    "一次完成 Cloudflare 管理员密钥生成、上传、验证和本机保存。",
    "",
    "用法：",
    "  npm run pilot:admin:setup",
    "  npm run pilot:admin:setup -- --url https://你的控制面地址",
    "",
    "说明：默认会轮换 PILOT_ADMIN_TOKEN；旧管理员密钥会立即失效。",
  ].join("\n"));
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfig = process.env.DASHOU_PILOT_CONTROL_WRANGLER_CONFIG?.trim()
  || join(repoRoot, "control-plane", "wrangler.jsonc");
if (!existsSync(wranglerConfig)) throw new Error(`找不到 Cloudflare 配置：${wranglerConfig}`);

const controlPlaneUrl = validateUrl(
  option("--url") || process.env.DASHOU_PILOT_CONTROL_URL || DEFAULT_PILOT_CONTROL_URL,
);
const adminToken = randomBytes(32).toString("hex");

console.log("搭手管理员初始化");
console.log(`控制面：${controlPlaneUrl}`);
console.log("正在检查 Cloudflare 登录状态……");
await run("npx", ["wrangler", "whoami", "--config", wranglerConfig]);

console.log("正在更新管理员密钥……");
await runSecretPut(adminToken, wranglerConfig);

console.log("正在验证管理员接口……");
const response = await fetch(new URL("/admin/applications?status=pending", controlPlaneUrl), {
  headers: { authorization: `Bearer ${adminToken}`, accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
});
const body = await readJson(response);
if (!response.ok) throw new Error(`控制面验证失败（HTTP ${response.status}）：${body.error || JSON.stringify(body)}`);

const configPath = writePilotAdminConfig({ controlPlaneUrl, adminToken });
console.log(`验证成功：待审核申请（${body.applications?.length ?? 0}）`);
console.log(`本机管理员配置已保存：${configPath}`);
console.log("以后直接运行：npm run pilot:admin -- applications list");

async function run(command, commandArgs) {
  const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
  const child = spawn(executable, commandArgs, { cwd: repoRoot, stdio: "inherit", env: process.env });
  const [code, signal] = await once(child, "close");
  if (code !== 0) throw new Error(`${command} 执行失败${signal ? `（${signal}）` : `（退出码 ${code}）`}`);
}

async function runSecretPut(secret, configPath) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  try {
    execFileSync(executable, ["wrangler", "secret", "put", "PILOT_ADMIN_TOKEN", "--config", configPath], {
      cwd: repoRoot,
      env: process.env,
      input: `${secret}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (error) {
    const code = error && typeof error === "object" && "status" in error ? error.status : undefined;
    throw new Error(`Cloudflare Secret 更新失败${code ? `（退出码 ${code}）` : ""}`);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { response: text };
  }
}

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} 需要一个值`);
  return value;
}

function validateUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`控制面地址无效：${value}`);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("非本机控制面必须使用 HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}
