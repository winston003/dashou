#!/usr/bin/env node

import { loadPilotAdminConfig } from "./pilot-admin-config.mjs";

const args = process.argv.slice(2);
const [scope, action, subject] = args;
const localAdminConfig = loadPilotAdminConfig();

if (!scope || ["help", "--help", "-h"].includes(scope)) {
  printHelp();
  process.exit(0);
}

if (scope === "applications") {
  if (!action || ["help", "--help", "-h"].includes(action)) {
    printApplicationHelp();
    process.exit(0);
  }
  if (action === "list") {
    const status = option("--status") || "pending";
    const path = status === "all" ? "/admin/applications" : `/admin/applications?status=${encodeURIComponent(status)}`;
    const payload = await call("GET", path);
    printApplications(payload.applications ?? [], status);
  } else if (action === "inspect") {
    const applicationId = requiredArgument(subject, "applicationId");
    const payload = await call("GET", `/admin/applications/${encodeURIComponent(applicationId)}`);
    printApplicationTimeline(payload.application, payload.events ?? []);
  } else if (action === "approve") {
    const applicationId = requiredArgument(subject, "applicationId");
    const period = option("--period") || "month";
    const subjectId = requiredArgument(option("--subject"), "--subject");
    const payload = await call("POST", `/admin/applications/${encodeURIComponent(applicationId)}/approve`, { period, subjectId });
    console.log(`已批准 ${payload.applicationId}，授权周期：${periodLabel(payload.period)}，到期：${formatDate(payload.expiresAt)}`);
    console.log(`设备连接：${payload.mcpUrl}`);
  } else if (action === "reject") {
    const applicationId = requiredArgument(subject, "applicationId");
    const reason = option("--reason");
    const payload = await call("POST", `/admin/applications/${encodeURIComponent(applicationId)}/reject`, reason ? { reason } : {});
    console.log(`已拒绝 ${payload.applicationId}${payload.reason ? `：${payload.reason}` : ""}`);
  } else if (action === "revoke") {
    const applicationId = requiredArgument(subject, "applicationId");
    const payload = await call("POST", `/admin/applications/${encodeURIComponent(applicationId)}/revoke`, {});
    console.log(`已撤销 ${payload.applicationId}`);
  } else if (action === "retire") {
    const applicationId = requiredArgument(subject, "applicationId");
    const reason = requiredArgument(option("--reason"), "--reason");
    const payload = await call("POST", `/admin/applications/${encodeURIComponent(applicationId)}/retire`, { reason });
    console.log(`已释放 ${payload.applicationId} 的 Cloudflare 连接资源`);
  } else if (action === "subject") {
    const applicationId = requiredArgument(subject, "applicationId");
    const subjectId = requiredArgument(option("--subject"), "--subject");
    const reason = requiredArgument(option("--reason"), "--reason");
    const payload = await call("POST", `/admin/applications/${encodeURIComponent(applicationId)}/subject`, { subjectId, reason });
    console.log(`已将 ${payload.applicationId} 关联到客户 ${payload.subjectId}`);
  } else {
    throw new Error(`未知申请操作：${action}`);
  }
} else if (scope === "accounts") {
  await legacyAccounts(action, subject, args[3]);
} else if (scope === "reset") {
  const confirm = option("--confirm");
  if (confirm !== "DELETE_ALL_DASHOU_PILOT_DATA") {
    throw new Error("为防止误删，必须提供 --confirm DELETE_ALL_DASHOU_PILOT_DATA");
  }
  const payload = await call("POST", "/admin/reset", { confirm });
  console.log(`Dashou 内测云端状态已清空；删除设备连接：${payload.deletedDevices ?? 0}`);
} else if (["list", "create", "enable", "disable", "revoke", "expire"].includes(scope)) {
  await legacyAccounts(scope, action, subject);
} else {
  throw new Error(`未知管理员命令：${scope}`);
}

async function legacyAccounts(command, accountId, value) {
  if (command === "list") {
    console.log(JSON.stringify(await call("GET", "/admin/pilot/accounts"), null, 2));
  } else if (command === "create") {
    requiredArgument(accountId, "accountId");
    requiredArgument(value, "expiresAt");
    console.log(JSON.stringify(await call("POST", "/admin/pilot/accounts", { accountId, expiresAt: value }), null, 2));
  } else if (["enable", "disable", "revoke", "expire"].includes(command)) {
    requiredArgument(accountId, "accountId");
    const body = command === "enable"
      ? { enabled: true }
      : command === "disable"
        ? { enabled: false }
        : command === "revoke"
          ? { revoke: true }
          : { expiresAt: requiredArgument(value, "expiresAt") };
    console.log(JSON.stringify(await call("POST", `/admin/pilot/accounts/${encodeURIComponent(accountId)}`, body), null, 2));
  } else {
    throw new Error(`未知账号操作：${command || "（空）"}`);
  }
}

async function call(method, path, body) {
  const credentials = resolveAdminCredentials();
  const baseUrl = requiredUrl(credentials.controlPlaneUrl, "DASHOU_PILOT_CONTROL_URL");
  const adminToken = requiredEnv(credentials.adminToken, "DASHOU_PILOT_CONTROL_ADMIN_TOKEN");
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { response: text };
  }
  if (!response.ok) throw new Error(`搭手控制面返回 HTTP ${response.status}：${payload.error || JSON.stringify(payload)}`);
  return payload;
}

function resolveAdminCredentials() {
  const envUrl = process.env.DASHOU_PILOT_CONTROL_URL?.trim();
  const envToken = process.env.DASHOU_PILOT_CONTROL_ADMIN_TOKEN?.trim();
  const useEnvironment = process.env.DASHOU_PILOT_ADMIN_USE_ENV === "1";
  if (useEnvironment || !localAdminConfig.adminToken) {
    return { controlPlaneUrl: envUrl || localAdminConfig.controlPlaneUrl, adminToken: envToken || localAdminConfig.adminToken };
  }
  if (!envUrl || sameUrl(envUrl, localAdminConfig.controlPlaneUrl)) {
    return localAdminConfig;
  }
  return { controlPlaneUrl: envUrl, adminToken: envToken || localAdminConfig.adminToken };
}

function sameUrl(left, right) {
  if (!left || !right) return false;
  return left.trim().replace(/\/+$/, "") === right.trim().replace(/\/+$/, "");
}

function printApplications(applications, status) {
  console.log(`${statusLabel(status)}（${applications.length}）`);
  if (applications.length === 0) {
    console.log("目前没有记录。");
    console.log("如果用户已经点击申请，请让用户点击“复制排查信息”并发给你；这表示控制面尚未收到成功申请。");
    return;
  }
  for (const application of applications) {
    console.log("");
    console.log(`${application.applicationId}  ${application.deviceName}`);
    console.log(`  ${application.platform} · 申请于 ${formatDate(application.createdAt)}${application.contact ? ` · ${application.contact}` : ""}`);
    if (application.period) console.log(`  授权：${periodLabel(application.period)} · 到期 ${formatDate(application.expiresAt)}`);
    if (application.reason) console.log(`  原因：${application.reason}`);
  }
  if (status === "pending") {
    console.log("");
    console.log("批准示例：dashou admin applications approve <申请编号> --period month --subject customer-alice");
  }
}

function printApplicationTimeline(application, events) {
  console.log(`申请 ${application.applicationId}`);
  console.log(`${application.deviceName} · ${application.platform} · 当前：${statusLabel(application.status)}`);
  const timeline = [
    [application.createdAt, "控制面收到申请"],
    [application.provisioningStartedAt, "管理员开始准备连接"],
    [application.approvedAt, "申请已批准，等待设备领取"],
    [application.activationStartedAt, "设备已领取安全配置"],
    [application.activatedAt, "设备已完成开通"],
    [application.rejectedAt, "申请未通过"],
    [application.revokedAt, "使用权限已撤销"],
  ].filter(([at]) => at).sort(([left], [right]) => Date.parse(left) - Date.parse(right));
  console.log("状态时间线：");
  for (const [at, label] of timeline) console.log(`  ${formatDate(at)}  ${label}`);
  if (application.expiresAt) console.log(`  ${formatDate(application.expiresAt)}  授权到期`);
  if (application.reason) console.log(`原因：${application.reason}`);
  if (events.length > 0) {
    console.log("客户端信号：");
    for (const event of events) {
      const at = Number.isSafeInteger(event.unixSeconds)
        ? new Date(event.unixSeconds * 1_000).toISOString()
        : event.receivedAt;
      console.log(`  ${formatDate(at)}  ${eventLabel(event.stage)}${event.outcome === "error" ? `（失败${event.errorCode ? `：${event.errorCode}` : ""}）` : ""} · v${event.appVersion}`);
    }
  }
}

function eventLabel(stage) {
  return ({
    app_opened: "打开客户端",
    first_seen: "首次被分析版本观测到",
    first_launch: "首次启动（旧版事件）",
    application_submit_started: "点击申请",
    application_submitted: "申请发送成功",
    application_submit_failed: "申请发送失败",
    application_status_failed: "状态查询失败",
    activation_completed: "领取配置完成",
    folders_selected: "已选择文件夹",
    runtime_start_started: "开始启动服务",
    runtime_started: "本地服务可用",
    runtime_start_failed: "本地服务启动失败",
    chatgpt_opened: "前往 ChatGPT",
    connection_password_copied: "复制授权密码",
    first_mcp_connection: "首次 MCP 连接",
    first_tool_call_attempt: "首次工具调用尝试",
    first_tool_call_success: "首次工具调用成功",
    first_tool_call_failure: "首次工具调用失败",
    first_mcp_use: "首次 MCP 工具调用（旧版事件）",
  })[stage] || stage;
}

function statusLabel(status) {
  return ({ all: "全部申请", pending: "待审核申请", provisioning: "正在开通", approved: "等待设备领取", activated: "已开通设备", expired: "已到期设备", rejected: "未通过申请", revoked: "已撤销设备" })[status] || `申请状态：${status}`;
}

function periodLabel(period) {
  return ({ week: "一周", month: "一个月", quarter: "一季度", year: "一年" })[period] || period;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return requiredArgument(args[index + 1], name);
}

function requiredEnv(value, name) {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required. 请先运行：npm run pilot:admin:setup`);
  return text;
}

function requiredUrl(value, name) {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required`);
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must use http or https`);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must use https outside localhost/127.0.0.1`);
  }
  return url;
}

function requiredArgument(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function printHelp() {
  console.log([
    "搭手管理员",
    "",
    "申请审核：",
    "  dashou admin applications list",
    "  dashou admin applications inspect <申请编号>",
    "  dashou admin applications approve <申请编号> --period week|month|quarter|year --subject <稳定客户标识>",
    "  dashou admin applications reject <申请编号> [--reason 原因]",
    "  dashou admin applications revoke <申请编号>",
    "  dashou admin applications retire <申请编号> --reason <释放原因>",
    "  dashou admin applications subject <申请编号> --subject <稳定客户标识> --reason <调整原因>",
    "  dashou admin reset --confirm DELETE_ALL_DASHOU_PILOT_DATA",
    "",
    "默认只列出待审核申请；使用 --status activated 查看已开通，或 --status all 查看全部。",
    "首次使用请运行：npm run pilot:admin:setup；配置会保存在本机 ~/.dashou/pilot-admin.json。",
    "旧的环境变量不会覆盖同一个控制面的本机配置；确需临时覆盖时设置 DASHOU_PILOT_ADMIN_USE_ENV=1。",
  ].join("\n"));
}

function printApplicationHelp() {
  printHelp();
}
