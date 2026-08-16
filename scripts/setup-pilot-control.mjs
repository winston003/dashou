#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PILOT_CONTROL_URL, writePilotAdminConfig } from "./pilot-admin-config.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "搭手控制面从零初始化",
    "",
    "一次生成并上传管理员密钥、激活密钥和租约签名密钥，同时保存本机管理员配置。",
    "Cloudflare API Token 必须从标准输入传入，不会出现在命令参数、日志或仓库中。",
    "",
    "用法：",
    "  pbpaste | npm run pilot:control:setup -- --cloudflare-token-stdin",
  ].join("\n"));
  process.exit(0);
}

if (!args.includes("--cloudflare-token-stdin")) {
  throw new Error("必须使用 --cloudflare-token-stdin 安全传入新的 Cloudflare API Token");
}

const cloudflareApiToken = readFileSync(0, "utf8").trim();
if (cloudflareApiToken.length < 20 || /\s/.test(cloudflareApiToken)) {
  throw new Error("标准输入中没有有效的 Cloudflare API Token");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfig = join(repoRoot, "control-plane", "wrangler.jsonc");
const controlPlaneUrl = DEFAULT_PILOT_CONTROL_URL;
const adminToken = randomBytes(32).toString("hex");
const activationKey = randomBytes(32).toString("base64url");
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

console.log("搭手控制面从零初始化");
console.log("1/4 检查 Cloudflare 登录状态");
run("npx", ["wrangler", "whoami", "--config", wranglerConfig]);

console.log("2/4 一次性上传新的 Dashou 密钥");
run("npx", ["wrangler", "secret", "bulk", "--config", wranglerConfig], JSON.stringify({
  CLOUDFLARE_API_TOKEN: cloudflareApiToken,
  PILOT_ADMIN_TOKEN: adminToken,
  DASHOU_ACTIVATION_KEY: activationKey,
  PILOT_LEASE_PRIVATE_KEY: privateKey,
  PILOT_LEASE_PUBLIC_KEY: publicKey,
}));

console.log("3/4 保存本机管理员配置");
const configPath = writePilotAdminConfig({ controlPlaneUrl, adminToken });

console.log("4/4 验证控制面管理员接口");
const response = await fetch(new URL("/admin/applications?status=pending", controlPlaneUrl), {
  headers: { authorization: `Bearer ${adminToken}`, accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`控制面验证失败（HTTP ${response.status}）：${body.error || "未知错误"}`);
console.log(`初始化完成：待审核申请 ${body.applications?.length ?? 0}，管理员配置 ${configPath}`);
console.log("Cloudflare API Token 已从标准输入读取；请立即清空剪贴板或关闭输入来源。");

function run(command, commandArgs, input) {
  const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
  execFileSync(executable, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    input: input === undefined ? undefined : `${input}\n`,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
}
