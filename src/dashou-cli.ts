#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import {
  expandHome,
  generateOwnerToken,
  loadDashouConfig,
  loadDashouFiles,
  normalizeBaseUrl,
  writeDashouAuth,
  writeDashouConfig,
  type DashouUserConfig,
} from "./dashou-config.js";
import { closeHttpServer, createDashouServer } from "./dashou-server.js";
import { cloudflaredVersion, startCloudflareTunnel, type RunningCloudflareTunnel } from "./dashou-tunnel.js";

const require = createRequire(import.meta.url);
const DEFAULT_PORT = 7677;

type Command = "serve" | "init" | "doctor" | "config" | "help" | "version";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();
  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await init(args.includes("--force"));
      return;
    case "doctor":
      doctor();
      return;
    case "config":
      configCommand(args);
      return;
    case "version":
      console.log(version());
      return;
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (["serve", "init", "doctor", "config"].includes(command)) return command as Command;
  if (["help", "--help", "-h"].includes(command)) return "help";
  if (["version", "--version", "-v"].includes(command)) return "version";
  throw new Error(`未知命令：${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDashouFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DASHOU_OAUTH_OWNER_TOKEN && process.env.DASHOU_ALLOWED_ROOTS) return;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("搭手尚未初始化。请先运行：dashou init");
  }
  await init(false);
}

async function init(force: boolean): Promise<void> {
  const files = loadDashouFiles();
  if (!force && files.configExists && files.authExists) {
    console.log(`搭手已经初始化：${files.dir}`);
    console.log("如需修改，运行：dashou init --force");
    return;
  }
  if (!input.isTTY || !output.isTTY) throw new Error("dashou init 需要交互式终端");

  const rl = createInterface({ input, output });
  try {
    console.log("\n搭手 · 让 ChatGPT 使用你授权的本地项目\n");
    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsText = await ask(rl, "允许 ChatGPT 访问哪些目录", defaultRoots);
    const allowedRoots = rootsText
      .split(",")
      .map((root) => resolve(expandHome(root.trim())))
      .filter(Boolean);
    if (allowedRoots.length === 0) throw new Error("至少需要授权一个目录");

    const defaultPort = String(files.config.port ?? DEFAULT_PORT);
    const portText = await ask(rl, "本地服务端口", defaultPort);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 到 65535 之间的整数");

    console.log("\nChatGPT 需要一个公网 HTTPS 地址访问你的搭手。内测阶段填写已经配置好的 Cloudflare Tunnel 域名，不带 /mcp。\n");
    const defaultPublicUrl = files.config.publicBaseUrl ?? "https://your-name.warmbyte.studio";
    const publicBaseUrl = normalizeBaseUrl(await ask(rl, "公网地址", defaultPublicUrl));
    if (new URL(publicBaseUrl).protocol !== "https:") {
      throw new Error("ChatGPT 连接请使用 https 地址");
    }

    const config: DashouUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };

    console.log("\n如果内测管理员给了 Cloudflare Tunnel Token，可以粘贴在这里；没有则直接回车，继续使用你自己维护的公网入口。\n");
    const tunnelTokenInput = (await rl.question("Tunnel Token（可留空）：")).trim();
    const tunnelToken = tunnelTokenInput || files.auth.tunnelToken;
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
      ...(tunnelToken ? { tunnelToken } : {}),
    };
    const configPath = writeDashouConfig(config);
    const authPath = writeDashouAuth(auth);

    console.log("\n搭手已初始化。\n");
    console.log(`配置：${configPath}`);
    console.log(`授权：${authPath}`);
    console.log(`ChatGPT MCP：${new URL("/mcp", publicBaseUrl).toString()}`);
    console.log(`连接密码：${auth.ownerToken}`);
    console.log(`Cloudflare Tunnel：${tunnelToken ? "已配置，dashou serve 会一起启动" : "未配置，使用外部 Tunnel"}`);
    console.log("\n下一步：运行 dashou serve\n");
  } finally {
    rl.close();
  }
}

async function serve(): Promise<void> {
  const { app, config, close } = createDashouServer();
  const httpServer = app.listen(config.port, config.host);
  await once(httpServer, "listening");

  console.log(`搭手已启动：http://${config.host}:${config.port}/mcp`);
  console.log(`ChatGPT MCP：${new URL("/mcp", config.publicBaseUrl).toString()}`);
  console.log(`授权目录：${config.allowedRoots.join(", ")}`);
  console.log("能力：打开项目、读取、写入、修改、执行命令");

  let tunnel: RunningCloudflareTunnel | undefined;
  if (config.tunnelToken) {
    const version = cloudflaredVersion();
    if (!version) {
      await closeHttpServer(httpServer, close);
      throw new Error("已配置 Tunnel Token，但没有找到 cloudflared。请先安装 cloudflared，或重新初始化并留空 Tunnel Token。");
    }
    tunnel = startCloudflareTunnel(config.tunnelToken);
    console.log(`Cloudflare Tunnel：已启动（${version}）`);
  } else {
    console.log("Cloudflare Tunnel：由外部管理");
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void (async () => {
      await tunnel?.close();
      await closeHttpServer(httpServer, close);
    })()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`搭手关闭失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function doctor(): void {
  const files = loadDashouFiles();
  console.log(`搭手 ${version()}`);
  console.log(`配置目录：${files.dir}`);
  console.log(`配置文件：${files.configExists ? "正常" : "缺失"}`);
  console.log(`授权文件：${files.authExists ? "正常" : "缺失"}`);
  console.log(`Node：${process.version}`);
  console.log(`平台：${process.platform} ${process.arch}`);
  console.log(`Bash：${checkCommand("bash", ["--version"])}`);
  console.log(`Git：${checkCommand("git", ["--version"])}`);
  try {
    const config = loadDashouConfig();
    console.log(`本地 MCP：http://${config.host}:${config.port}/mcp`);
    console.log(`公网 MCP：${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`授权目录：${config.allowedRoots.join(", ")}`);
    console.log(`Cloudflare Tunnel：${config.tunnelToken ? "已配置" : "未配置"}`);
    console.log(`cloudflared：${cloudflaredVersion() ?? "不可用"}`);
    console.log("工具：open_project, read, write, edit, execute");
  } catch (error) {
    console.log(`配置状态：${error instanceof Error ? error.message : String(error)}`);
  }
}

function configCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDashouFiles();
  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }
  if (subcommand !== "set" || key !== "publicBaseUrl") {
    throw new Error("目前只支持：dashou config set publicBaseUrl <url>");
  }
  const value = rest.join(" ").trim();
  if (!value) throw new Error("缺少 publicBaseUrl");
  const publicBaseUrl = normalizeBaseUrl(value);
  writeDashouConfig({ ...files.config, publicBaseUrl });
  console.log(`已更新：${files.configPath}`);
}

function printHelp(): void {
  console.log([
    "搭手 Dashou",
    "让 ChatGPT 直接、安全地操作你授权的本地文件和项目。",
    "",
    "用法：",
    "  dashou                 初始化后启动",
    "  dashou init            选择授权目录并配置连接",
    "  dashou serve           启动本地 MCP 服务",
    "  dashou doctor          检查环境与配置",
    "  dashou config get      查看配置",
    "  dashou config set publicBaseUrl <url>",
    "  dashou -v              查看版本",
    "",
    "V0 只暴露：open_project / read / write / edit / execute",
  ].join("\n"));
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await rl.question(`${label} [${defaultValue}]：`)).trim();
  return answer || defaultValue;
}

function checkCommand(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).split("\n")[0]?.trim() || "正常";
  } catch {
    return "不可用";
  }
}

function version(): string {
  const pkg = require("../package.json") as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("无法读取搭手版本号");
  return pkg.version;
}

function assertSupportedNode(): void {
  const [majorText, minorText] = process.versions.node.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  const supported = (major === 22 && minor >= 19) || (major > 22 && major < 27);
  if (!supported) {
    throw new Error(`搭手需要 Node >=22.19 <27，当前版本 ${process.version}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
