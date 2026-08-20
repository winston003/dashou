import { loadPilotAdminConfig } from "../../scripts/pilot-admin-config.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPLICATION_ID_PATTERN = /^req_[A-Za-z0-9_-]{16,64}$/;
const APPLICATION_STATUSES = new Set([
  "pending",
  "provisioning",
  "approved",
  "activated",
  "expired",
  "rejected",
  "revoked",
]);
const BODY_LIMIT_BYTES = 8 * 1024;
const RESPONSE_LIMIT_BYTES = 1024 * 1024;

export function createDashouAdminApiPlugin(options = {}) {
  const requestImpl = options.requestImpl ?? requestViaCurl;

  return {
    name: "dashou-local-admin-api",
    configureServer(server) {
      server.middlewares.use("/api/admin", async (request, response) => {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");

        try {
          if (!isLoopbackAddress(request.socket?.remoteAddress)) {
            return sendJson(response, 403, { error: "管理员 API 只允许本机访问" });
          }

          const route = resolveAdminRoute(request.method, request.url);
          if (!route) return sendJson(response, 404, { error: "不支持的管理员操作" });

          if (route.method === "POST" && !isSameOriginRequest(request)) {
            return sendJson(response, 403, { error: "拒绝跨站管理员操作" });
          }

          const body = route.method === "POST" ? await readJsonBody(request) : undefined;
          const upstream = await requestImpl(route, body);
          response.statusCode = upstream.status;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(upstream.body);
        } catch (error) {
          const status = error instanceof LocalAdminError ? error.status : 502;
          sendJson(response, status, {
            error: error instanceof Error ? error.message : "无法连接搭手控制面",
          });
        }
      });
    },
  };
}

export async function requestViaCurl(route, body) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dashou-admin-request-"));
  const bodyPath = join(temporaryDirectory, "body.json");
  if (body !== undefined) await writeFile(bodyPath, JSON.stringify(body), { mode: 0o600 });
  try {
    const credentials = loadAdminCredentials();
    const upstreamUrl = new URL(route.upstreamPath, credentials.controlPlaneUrl).toString();
    const proxyUrl = resolveProxyUrl();
    const config = [
      `url = "${curlConfigValue(upstreamUrl)}"`,
      `request = "${route.method}"`,
      `header = "accept: application/json"`,
      `header = "content-type: application/json"`,
      `header = "authorization: Bearer ${curlConfigValue(credentials.adminToken)}"`,
      ...(body === undefined ? [] : [`data-binary = "@${curlConfigValue(bodyPath)}"`]),
      ...(proxyUrl ? [`proxy = "${curlConfigValue(proxyUrl)}"`] : []),
      "silent",
      "show-error",
      "connect-timeout = 15",
      "max-time = 30",
      "",
    ].join("\n");
    const stdout = execFileSync("curl", ["--config", "-", "--write-out", "\\n%{http_code}"], {
      encoding: "utf8",
      env: process.env,
      input: config,
      maxBuffer: RESPONSE_LIMIT_BYTES,
      timeout: 35_000,
    });
    const statusSeparator = stdout.lastIndexOf("\n");
    const status = Number.parseInt(stdout.slice(statusSeparator + 1), 10);
    const responseBody = stdout.slice(0, statusSeparator);
    if (statusSeparator === -1 || !Number.isInteger(status) || !responseBody) {
      throw new LocalAdminError(502, "搭手控制面响应格式异常");
    }
    JSON.parse(responseBody);
    return { status, body: responseBody };
  } catch (error) {
    if (error instanceof LocalAdminError) throw error;
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    const detail = stderr.toLowerCase().includes("timed out") ? "连接超时" : "请求失败";
    throw new LocalAdminError(502, `无法连接搭手控制面：${detail}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function curlConfigValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

function resolveProxyUrl(env = process.env) {
  const configured = env.DASHOU_ADMIN_PROXY_URL ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY;
  if (configured) return safeProxyUrl(configured);
  try {
    const shellValue = execFileSync("/bin/zsh", ["-lc", "printenv HTTPS_PROXY || printenv https_proxy || printenv ALL_PROXY || true"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (shellValue) return safeProxyUrl(shellValue);
  } catch {
    // Continue to the local listener probe.
  }
  try {
    execFileSync("/usr/bin/nc", ["-z", "-w", "1", "127.0.0.1", "1082"], { stdio: "ignore", timeout: 2_000 });
    return "http://127.0.0.1:1082";
  } catch {
    return undefined;
  }
}

function safeProxyUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:", "socks4:", "socks5:", "socks5h:"].includes(url.protocol)) {
    throw new LocalAdminError(503, "管理员代理地址协议不受支持");
  }
  return url.toString();
}

export function resolveAdminRoute(method = "GET", requestUrl = "/") {
  const normalizedMethod = method.toUpperCase();
  const url = new URL(requestUrl, "http://localhost");
  const pathname = url.pathname.replace(/^\/api\/admin/, "");

  if (normalizedMethod === "GET" && pathname === "/applications") {
    const unexpectedKeys = [...url.searchParams.keys()].filter((key) => key !== "status");
    if (unexpectedKeys.length > 0) return null;
    const status = url.searchParams.get("status");
    if (status && status !== "all" && !APPLICATION_STATUSES.has(status)) return null;
    const query = status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
    return { method: "GET", upstreamPath: `/admin/applications${query}` };
  }

  if (normalizedMethod === "GET" && pathname === "/analytics" && !url.search) {
    return { method: "GET", upstreamPath: "/admin/analytics" };
  }

  const detailMatch = /^\/applications\/([^/]+)$/.exec(pathname);
  if (normalizedMethod === "GET" && detailMatch && isApplicationId(detailMatch[1]) && !url.search) {
    return { method: "GET", upstreamPath: `/admin/applications/${encodeURIComponent(detailMatch[1])}` };
  }

  const actionMatch = /^\/applications\/([^/]+)\/(approve|reject|reopen|period|extend|notes|revoke|retire|restore|authorization|profile|subject)$/.exec(pathname);
  if (normalizedMethod === "POST" && actionMatch && isApplicationId(actionMatch[1]) && !url.search) {
    return {
      method: "POST",
      upstreamPath: `/admin/applications/${encodeURIComponent(actionMatch[1])}/${actionMatch[2]}`,
    };
  }

  return null;
}

export function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isSameOriginRequest(request) {
  const origin = request.headers?.origin;
  const host = request.headers?.host;
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    return ["http:", "https:"].includes(originUrl.protocol) && originUrl.host === host;
  } catch {
    return false;
  }
}

function isApplicationId(value) {
  try {
    return APPLICATION_ID_PATTERN.test(decodeURIComponent(value));
  } catch {
    return false;
  }
}

export function loadAdminCredentials(env = process.env) {
  const local = loadPilotAdminConfig(env);
  const useEnvironment = env.DASHOU_PILOT_ADMIN_USE_ENV === "1";
  const controlPlaneUrl = useEnvironment ? env.DASHOU_PILOT_CONTROL_URL?.trim() : local.controlPlaneUrl;
  const adminToken = useEnvironment ? env.DASHOU_PILOT_CONTROL_ADMIN_TOKEN?.trim() : local.adminToken;
  if (!controlPlaneUrl || !adminToken) {
    throw new LocalAdminError(503, "管理员配置缺失，请先运行 npm run pilot:admin:setup");
  }
  const parsedUrl = new URL(controlPlaneUrl);
  const localUrl = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && localUrl)) {
    throw new LocalAdminError(503, "管理员控制面地址必须使用 HTTPS");
  }
  return { controlPlaneUrl: parsedUrl, adminToken };
}

async function readJsonBody(request) {
  const contentType = request.headers?.["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new LocalAdminError(415, "管理员操作必须使用 JSON");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new LocalAdminError(413, "管理员操作内容过大");
    chunks.push(chunk);
  }

  try {
    const text = Buffer.concat(chunks).toString("utf8");
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new LocalAdminError(400, "管理员操作内容必须是 JSON 对象");
  }
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

class LocalAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
