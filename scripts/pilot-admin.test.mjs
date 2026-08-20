import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { writePilotAdminConfig } from "./pilot-admin-config.mjs";

const execFileAsync = promisify(execFile);

test("admin CLI lists and approves device applications from any working directory", async (context) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url.includes("?status=")) {
        response.end(JSON.stringify({ applications: [{
          applicationId: "req_testapplication1234",
          status: "pending",
          deviceName: "Alice Mac",
          platform: "macos-arm64",
          createdAt: "2026-08-16T00:00:00.000Z",
        }] }));
      } else if (request.method === "GET") {
        response.end(JSON.stringify({ resourcePolicy: { version: 1, enforced: true, requiresSubjectId: true, maxRetainedResources: 180 }, application: {
          applicationId: "req_testapplication1234",
          status: "approved",
          deviceName: "Alice Mac",
          platform: "macos-arm64",
          createdAt: "2026-08-16T00:00:00.000Z",
          provisioningStartedAt: "2026-08-16T00:01:00.000Z",
          approvedAt: "2026-08-16T00:02:00.000Z",
          expiresAt: "2026-09-16T00:02:00.000Z",
        } }));
      } else {
        response.end(JSON.stringify({
          applicationId: "req_testapplication1234",
          status: "approved",
          period: "month",
          expiresAt: "2026-09-16T00:00:00.000Z",
          mcpUrl: "https://device-test.warmbyte.studio/mcp",
        }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => server.close());
  const address = server.address();
  const adminConfigPath = join(mkdtempSync(join(tmpdir(), "dashou-pilot-admin-cli-")), "pilot-admin.json");
  writePilotAdminConfig({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    adminToken: "admin-config-token",
  }, { DASHOU_PILOT_ADMIN_CONFIG: adminConfigPath });
  const env = {
    ...process.env,
    DASHOU_PILOT_CONTROL_URL: `http://127.0.0.1:${address.port}`,
    DASHOU_PILOT_CONTROL_ADMIN_TOKEN: "stale-environment-token",
    DASHOU_PILOT_ADMIN_CONFIG: adminConfigPath,
  };
  const script = new URL("./pilot-admin.mjs", import.meta.url);
  const listed = await execFileAsync(process.execPath, [script.pathname, "applications", "list"], { cwd: "/tmp", env });
  assert.match(listed.stdout, /待审核申请（1）/);
  assert.match(listed.stdout, /Alice Mac/);
  const inspected = await execFileAsync(process.execPath, [script.pathname, "applications", "inspect", "req_testapplication1234"], { cwd: "/tmp", env });
  assert.match(inspected.stdout, /状态时间线/);
  assert.match(inspected.stdout, /控制面收到申请/);
  assert.match(inspected.stdout, /申请已批准，等待设备领取/);
  const approved = await execFileAsync(process.execPath, [script.pathname, "applications", "approve", "req_testapplication1234", "--period", "month", "--subject", "customer-alice"], { cwd: "/tmp", env });
  assert.match(approved.stdout, /已批准 req_testapplication1234/);
  assert.deepEqual(requests.map(({ method, url, authorization }) => ({ method, url, authorization })), [
    { method: "GET", url: "/admin/applications?status=pending", authorization: "Bearer admin-config-token" },
    { method: "GET", url: "/admin/applications/req_testapplication1234", authorization: "Bearer admin-config-token" },
    { method: "GET", url: "/admin/applications/req_testapplication1234", authorization: "Bearer admin-config-token" },
    { method: "POST", url: "/admin/applications/req_testapplication1234/approve", authorization: "Bearer admin-config-token" },
  ]);
  assert.deepEqual(JSON.parse(requests[3].body), { period: "month", subjectId: "customer-alice" });
});
