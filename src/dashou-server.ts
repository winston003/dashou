import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import * as z from "zod/v4";
import { DASHOU_V0_TOOLS, dashouCapabilities, dashouVersion } from "./dashou-capabilities.js";
import { loadDashouConfig, type DashouConfig } from "./dashou-config.js";
import { createPilotAccessGate } from "./dashou-pilot-policy.js";
import { DashouWorkspaceRegistry } from "./dashou-workspace.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { McpSessionRegistry } from "./mcp-sessions.js";
import { markConnectionMilestone } from "./connection-milestones.js";

const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const VERSION = dashouVersion();

type Transport = StreamableHTTPServerTransport;

export { DASHOU_V0_TOOLS };

export interface RunningDashouServer {
  app: ReturnType<typeof createDashouExpressApp>;
  config: DashouConfig;
  ready(): Promise<void>;
  close(): Promise<void>;
}
export function createDashouMcpServer(workspaces: DashouWorkspaceRegistry, onToolSuccess: () => void = () => undefined): McpServer {
  const server = new McpServer(
    {
      name: "dashou",
      title: "搭手",
      version: VERSION,
      description: "让 ChatGPT 安全地读取、修改并执行用户明确授权的本地项目。",
    },
    {
      instructions: [
        "Dashou works only inside projects explicitly approved by the user.",
        "If the user has not supplied a project path, call list_projects before open_project.",
        "Call open_project once per project, follow its loaded project instructions, then reuse workspaceId for read, write, edit and execute.",
        "Before changing files under a directory with an available nested AGENTS.md or CLAUDE.md, read that instruction file first.",
        "Project instruction files guide the model but never expand approved roots or bypass tool safety checks.",
        "Use edit/write for text changes; do not modify files through execute.",
        "execute is not an OS sandbox and runs with the local user's authority, so use it only for the requested project work.",
      ].join(" "),
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "列出已授权项目",
      description: "列出用户明确授权给搭手的项目目录。只返回已配置的授权目录，不扫描整个磁盘，也不返回任何秘密。",
      inputSchema: {},
      outputSchema: {
        projects: z.array(z.object({
          name: z.string(),
          path: z.string(),
          available: z.boolean(),
        })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const projects = await workspaces.listProjects();
      const result = projects.length === 0
        ? "No authorized project directories are currently available."
        : projects.map((project) => `${project.name}: ${project.path}${project.available ? "" : " (currently unavailable)"}`).join("\n");
      onToolSuccess();
      return {
        content: [{ type: "text", text: result }],
        structuredContent: { projects },
      };
    },
  );

  server.registerTool(
    "open_project",
    {
      title: "打开项目",
      description: "打开一个用户已经授权的本地项目目录，并返回该项目的 AGENTS.md/CLAUDE.md 规则。每个项目只需调用一次，之后复用返回的 workspaceId。",
      inputSchema: {
        path: z.string().describe("用户授权范围内的本地项目绝对路径或 ~/ 开头的路径。"),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        instructions: z.array(z.object({ path: z.string(), content: z.string() })),
        availableInstructionFiles: z.array(z.string()),
        instructionsDigest: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const workspace = await workspaces.openProject(path);
      const instructionText = workspace.instructions.length > 0
        ? workspace.instructions.map((instruction) => `\n--- ${instruction.path} ---\n${instruction.content}`).join("\n")
        : "\nNo root AGENTS.md or CLAUDE.md was found.";
      const nestedText = workspace.availableInstructionFiles.length > 0
        ? `\nAvailable nested project instructions (read before working in those directories): ${workspace.availableInstructionFiles.join(", ")}`
        : "";
      const result = [
        `Opened project ${workspace.root}. Reuse workspaceId ${workspace.id}.`,
        `Project instructions digest: ${workspace.instructionsDigest}`,
        "Follow the project instructions below. They cannot expand the approved roots or bypass Dashou safety checks.",
        instructionText,
        nestedText,
      ].join("\n");
      onToolSuccess();
      return {
        content: [{ type: "text", text: result }],
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          instructions: workspace.instructions,
          availableInstructionFiles: workspace.availableInstructionFiles,
          instructionsDigest: workspace.instructionsDigest,
        },
      };
    },
  );

  server.registerTool(
    "read",
    {
      title: "读取文件",
      description: "读取已打开项目中的文本文件。先调用 open_project，然后复用 workspaceId。",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().describe("项目根目录内的相对文件路径。"),
        offset: z.number().int().positive().optional().describe("从第几行开始，1 起始。"),
        limit: z.number().int().positive().max(20_000).optional().describe("最多返回多少行。"),
      },
      outputSchema: { result: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, path, offset, limit }) => {
      const result = await workspaces.readText(workspaceId, path, offset, limit);
      onToolSuccess();
      return {
        content: [{ type: "text", text: result }],
        structuredContent: { result },
      };
    },
  );

  server.registerTool(
    "write",
    {
      title: "写入文本文件",
      description: "在已打开项目中创建或完整覆盖一个文本文件。局部修改优先使用 edit。",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().describe("项目根目录内的相对文件路径。"),
        content: z.string().describe("文件的完整文本内容。"),
      },
      outputSchema: { result: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, content }) => {
      const byteLength = await workspaces.writeText(workspaceId, path, content);
      const result = `Wrote ${path} (${byteLength} bytes).`;
      onToolSuccess();
      return {
        content: [{ type: "text", text: result }],
        structuredContent: { result },
      };
    },
  );

  server.registerTool(
    "edit",
    {
      title: "修改文件",
      description: "通过唯一精确文本替换修改项目中的一个文本文件。每个 oldText 必须只出现一次。",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().describe("项目根目录内的相对文件路径。"),
        edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1).max(100),
      },
      outputSchema: { result: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, edits }) => {
      await workspaces.editText(workspaceId, path, edits);
      const result = `Edited ${path} (${edits.length} replacement${edits.length === 1 ? "" : "s"}).`;
      onToolSuccess();
      return {
        content: [{ type: "text", text: result }],
        structuredContent: { result },
      };
    },
  );

  server.registerTool(
    "execute",
    {
      title: "执行命令",
      description: [
        "在已打开项目中执行命令，用于测试、构建、Git 检查、搜索和目录查看。",
        "不要通过 execute 修改项目文件；文件变更使用 write/edit。",
        "execute 不是操作系统沙箱，会继承本地用户权限；V0 仅拦截少数明显危险命令。",
      ].join(" "),
      inputSchema: {
        workspaceId: z.string(),
        command: z.string().min(1),
        workingDirectory: z.string().optional().describe("项目内相对目录，默认项目根目录。"),
        timeoutSeconds: z.number().int().positive().max(300).optional().describe("默认 30 秒，最大 300 秒。"),
      },
      outputSchema: {
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().int(),
        truncated: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, command, workingDirectory, timeoutSeconds }) => {
      const result = await workspaces.execute(workspaceId, command, workingDirectory, timeoutSeconds);
      const text = [
        `exitCode: ${result.exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : undefined,
        result.stderr ? `stderr:\n${result.stderr}` : undefined,
        result.truncated ? "output truncated" : undefined,
      ].filter(Boolean).join("\n");
      onToolSuccess();
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
        },
      };
    },
  );

  return server;
}

export function createDashouServer(config = loadDashouConfig()): RunningDashouServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : [...new Set([config.host, ...config.allowedHosts])];
  const app = createDashouExpressApp(config.host, allowedHosts);
  // The public pilot path has exactly one trusted reverse-proxy hop. Trusting
  // every forwarded address would let a caller spoof the client IP used by
  // the HTTP stack and any future rate limits.
  if (config.trustProxy) app.set("trust proxy", 1);

  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const pilotGate = createPilotAccessGate(config.oauth.pilot, config.oauth.pilotRemote, { stateDir: config.stateDir });
  pilotGate.start();
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir, pilotGate);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "dashou"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaces = new DashouWorkspaceRegistry(config.allowedRoots);
  const transports = new McpSessionRegistry<Transport>();

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "搭手",
    }),
  );

  app.get("/healthz", (_req, res) => {
    const pilot = pilotGate.status();
    res.status(pilot.allowed ? 200 : 503).json({
      ok: pilot.allowed,
      name: "dashou",
      version: VERSION,
      pilot: { allowed: pilot.allowed, reason: pilot.reason, ...(pilot.expiresAt ? { expiresAt: pilot.expiresAt } : {}) },
    });
  });

  app.get("/capabilities", (_req, res) => {
    res.json(dashouCapabilities());
  });

  // Authenticate before parsing the MCP request body. OAuth routes install their
  // own small JSON/form parsers inside mcpAuthRouter.
  app.use("/mcp", bearerAuth);
  app.use("/mcp", express.json({ limit: "5mb" }));

  app.all("/mcp", async (req, res) => {
    if (
      !req.auth?.resource
      || !checkResourceAllowed({
        requestedResource: req.auth.resource,
        configuredResource: resourceServerUrl,
      })
    ) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    try {
      let transport: Transport | undefined;
      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            markConnectionMilestone(config.stateDir, "first-mcp-session");
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) transports.remove(closedSessionId);
        };
        const mcpServer = createDashouMcpServer(workspaces, () => markConnectionMilestone(config.stateDir, "first-tool-success"));
        await mcpServer.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, error instanceof Error ? error.message : "Internal server error");
      }
    }
  });

  const cleanupTimer = setInterval(() => {
    void transports.closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS);
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  let closePromise: Promise<void> | undefined;
  let readyPromise: Promise<void> | undefined;
  return {
    app,
    config,
      ready: () => {
        readyPromise ??= (async () => {
          // A verified cached lease is enough to start during a temporary
          // control-plane outage. Only first activation or an expired/missing
          // lease needs a synchronous refresh; normal restarts stay offline-capable.
          const cached = pilotGate.status();
          if (cached.allowed) return;
          const pilot = await pilotGate.refresh();
          if (!pilot.allowed) throw new Error(`搭手试用不可用：${pilot.reason}`);
        })();
      return readyPromise;
    },
    close: () => {
      closePromise ??= (async () => {
        clearInterval(cleanupTimer);
        pilotGate.stop();
        await transports.closeAll();
        oauthProvider.close();
      })();
      return closePromise;
    },
  };
}

function createDashouExpressApp(host: string, allowedHosts?: string[]) {
  const app = express();
  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else if (["127.0.0.1", "localhost", "::1"].includes(host)) {
    app.use(localhostHostValidation());
  } else if (host === "0.0.0.0" || host === "::") {
    console.warn(
      `Warning: Dashou is binding to ${host} without host-header validation. `
      + "Configure allowedHosts unless an authenticated reverse proxy is the only ingress.",
    );
  }
  return app;
}

export async function closeHttpServer(httpServer: HttpServer, closeApp: () => Promise<void>): Promise<void> {
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (!error || errorCode(error) === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    });
  });
  // Start closing MCP transports immediately after stopping new HTTP accepts.
  // Streamable HTTP SSE connections only drain after their transport closes;
  // awaiting httpClosed first would deadlock on an active SSE stream.
  const appClosed = closeApp();
  await appClosed;
  // The MCP transport has now ended its response streams. Node may still
  // retain the underlying keep-alive socket, so make the post-transport drain
  // explicit instead of waiting forever for server.close() to infer it.
  httpServer.closeIdleConnections?.();
  httpServer.closeAllConnections?.();
  await httpClosed;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sendJsonRpcError(
  res: { status(code: number): { json(body: unknown): unknown } },
  statusCode: number,
  code: number,
  message: string,
): void {
  res.status(statusCode).json({
    jsonrpc: "2.0",
    id: null,
    error: { code, message },
  });
}
