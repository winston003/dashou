import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./styles.css";

const $ = (id) => document.getElementById(id);
const setup = $("setup");
const ready = $("ready");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHATGPT_APPS_URL = "https://chatgpt.com/plugins";
let updatePromise;
let refreshPromise;
let currentMcpUrl;
let configuring = false;
let accessReady = false;
let accessState = { status: "not_applied" };
let applying = false;
let selectedRoots = [];
let restarting = false;

function errorText(error) {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return String(error ?? "");
}

function friendlyError(error, fallback = "搭手暂时没有准备好，请稍后再试。") {
  const raw = errorText(error);
  if (raw.includes("DASHOU_ALREADY_RUNNING") || raw.includes("已经在运行")) {
    return "搭手已经在运行，正在继续使用。";
  }
  if (raw.includes("DASHOU_OTHER_PROCESS") || raw.includes("其他程序占用")) {
    return "搭手暂时无法启动，请先关闭正在使用本机搭手服务的其他程序。";
  }
  if (raw.includes("EADDRINUSE") || raw.toLowerCase().includes("address already in use")) {
    return "搭手暂时无法启动，请稍后再试。";
  }
  if (raw.includes("启动后立即退出") || raw.includes("无法启动搭手服务")) {
    return "搭手没有成功启动，请点击“重新启动”再试。";
  }
  if (raw.includes("network is unreachable") || raw.includes("i/o timeout") || raw.includes("lookup ")) {
    return "搭手已启动，正在等待网络连接。网络恢复后会自动继续。";
  }
  if (raw.includes("无法读取邀请文件") || raw.includes("邀请文件格式不正确")) {
    return "没能打开这份邀请文件，请重新选择管理员发来的文件。";
  }
  if (raw.includes("受支持的搭手邀请文件") || raw.includes("缺少有效的内测授权")) {
    return "这不是有效的搭手邀请文件，请让管理员重新生成一份。";
  }
  if (raw.includes("至少需要一个授权目录")) {
    return "请至少选择一个工作文件夹。";
  }
  if (raw.includes("授权目录必须")) {
    return "请选择真实的工作文件夹。";
  }
  return fallback;
}

function showReadyFailure(error) {
  setup.classList.add("hidden");
  ready.classList.remove("hidden");
  $("connect-chatgpt").disabled = true;
  $("status-dot").className = "dot bad";
  $("status-text").textContent = "搭手需要恢复";
  $("ready-copy").textContent = friendlyError(error);
  $("restart-daemon").classList.remove("hidden");
}

function showSetupError(error) {
  $("setup-error").textContent = friendlyError(error, "这一步没有完成，请再试一次。");
}

function uniqueRoots(roots) {
  return [...new Set(roots.map((root) => String(root).trim()).filter(Boolean))];
}

function renderRoots() {
  const list = $("roots-list");
  list.replaceChildren();
  if (selectedRoots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "roots-empty";
    empty.textContent = "还没有选择文件夹";
    list.append(empty);
  } else {
    for (const root of selectedRoots) {
      const row = document.createElement("div");
      row.className = "root-row";
      const path = document.createElement("code");
      path.textContent = root;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-root";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", "移除文件夹 " + root);
      remove.addEventListener("click", () => {
        selectedRoots = selectedRoots.filter((candidate) => candidate !== root);
        renderSetupState();
      });
      row.append(path, remove);
      list.append(row);
    }
  }
  $("roots-count").textContent = selectedRoots.length
    ? "已选择 " + selectedRoots.length + " 个文件夹"
    : "可选择一个或多个文件夹";
}

function renderSetupState() {
  const hasRoots = selectedRoots.length > 0;
  const status = accessState?.status || "not_applied";
  const accessStatus = $("access-status");
  const applyButton = $("apply-access");
  if (accessReady) {
    accessStatus.textContent = "已开通，可以继续";
    accessStatus.className = "setup-status ready";
    applyButton.textContent = "已开通";
    applyButton.disabled = true;
  } else if (["pending", "provisioning"].includes(status)) {
    accessStatus.textContent = status === "provisioning" ? "管理员已同意，正在准备" : "申请已发送，等待管理员同意";
    accessStatus.className = "setup-status waiting";
    applyButton.textContent = "等待审核";
    applyButton.disabled = true;
  } else if (status === "rejected") {
    accessStatus.textContent = accessState.reason || "申请未通过，请联系管理员";
    accessStatus.className = "setup-status";
    applyButton.textContent = "重新申请";
    applyButton.disabled = applying;
  } else if (["expired", "revoked"].includes(status)) {
    accessStatus.textContent = status === "expired" ? "使用期限已结束，如需继续可重新申请" : "使用权限已结束，如需继续可重新申请";
    accessStatus.className = "setup-status";
    applyButton.textContent = "重新申请";
    applyButton.disabled = applying;
  } else {
    accessStatus.textContent = applying ? "正在发送申请" : "尚未申请";
    accessStatus.className = applying ? "setup-status waiting" : "setup-status";
    applyButton.textContent = applying ? "正在申请" : "申请开通";
    applyButton.disabled = applying;
  }
  $("save-start").disabled = !(accessReady && hasRoots);
  renderRoots();
}

async function loadSetupState() {
  let existing = await invoke("configuration");
  if (existing) {
    if (selectedRoots.length === 0) selectedRoots = uniqueRoots(existing.allowedRoots || []);
    accessReady = Boolean(existing.hasPilotToken);
  }
  try {
    accessState = await invoke("application_status");
    if (accessState.status === "activated") {
      existing = await invoke("configuration");
      accessReady = Boolean(existing?.hasPilotToken);
    } else if (accessState.status !== "not_applied") {
      accessReady = false;
    }
  } catch (error) {
    if (!accessReady && !["pending", "provisioning"].includes(accessState.status)) {
      $("setup-error").textContent = friendlyError(error, "暂时无法查看申请进度，请稍后再试。");
    }
  }
  renderSetupState();
}

async function checkAndInstallUpdate({ silent = false } = {}) {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    try {
      const update = await check();
      if (!update) {
        if (!silent) $("message").textContent = "当前已经是最新版本。";
        return false;
      }
      $("message").textContent = `发现 ${update.version}，正在自动更新…`;
      await update.downloadAndInstall();
      await relaunch();
      return true;
    } catch (error) {
      if (!silent) $("message").textContent = "更新没有完成，请稍后再试。";
      return false;
    } finally {
      updatePromise = undefined;
    }
  })();
  return updatePromise;
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const current = await invoke("status");
    $("app-version").textContent = current.version ? "v" + current.version : "";
    if (current.configured && !configuring) {
      try {
        const remoteAccess = await invoke("application_status");
        if (remoteAccess.status !== "not_applied" && remoteAccess.status !== "activated") {
          accessState = remoteAccess;
          accessReady = false;
          setup.classList.remove("hidden");
          ready.classList.add("hidden");
          await loadSetupState();
          return;
        }
      } catch {
        // A valid local signed lease may continue during a short control-plane outage.
      }
    }
    if (!current.configured || configuring) {
      setup.classList.remove("hidden");
      ready.classList.add("hidden");
      await loadSetupState();
      return;
    }
    if (!current.running) {
      try {
        await invoke("start_daemon");
      } catch (error) {
        showReadyFailure(error);
        return;
      }
    }
    const actual = await invoke("status");
    setup.classList.add("hidden");
    ready.classList.remove("hidden");
    currentMcpUrl = actual.mcpUrl || undefined;
    const readyForChatGPT = actual.running && actual.localHealth && actual.publicHealth;
    const localOnly = actual.running && actual.localHealth;
    $("connect-chatgpt").disabled = !readyForChatGPT;
    $("restart-daemon").classList.toggle("hidden", actual.localHealth);
    $("status-text").textContent = readyForChatGPT
      ? "可以连接 ChatGPT"
      : localOnly
        ? "正在建立连接"
        : actual.running
          ? "搭手需要恢复"
          : "搭手尚未准备好";
    $("ready-copy").textContent = readyForChatGPT
      ? "搭手已准备好。下方按钮会复制连接地址，并直接打开 ChatGPT 的添加页面。"
      : localOnly
        ? "搭手已经启动，正在完成最后的连接。"
        : "搭手没有正常启动，请点击“重新启动”再试。";
    $("status-dot").className = "dot " + (readyForChatGPT ? "ok" : localOnly ? "warn" : "bad");
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = undefined;
  }
}

$("save-start").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  configuring = true;
  let saved = false;
  try {
    await invoke("configure", {
      settings: {
        allowedRoots: selectedRoots,
        publicBaseUrl: "",
        pilotToken: "",
        tunnelToken: null,
        port: 7677,
      },
    });
    saved = true;
    await invoke("take_over_daemon");
    await invoke("start_daemon");
    configuring = false;
    await refresh();
  } catch (error) {
    configuring = false;
    if (saved) showReadyFailure(error);
    else showSetupError(error);
  }
});

$("apply-access").addEventListener("click", async () => {
  if (applying || accessReady) return;
  applying = true;
  $("setup-error").textContent = "";
  renderSetupState();
  try {
    accessState = await invoke("apply_for_access");
  } catch (error) {
    showSetupError(error);
  } finally {
    applying = false;
    renderSetupState();
  }
});

$("choose-folder").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    const selected = await open({ directory: true, multiple: true, title: "选择 ChatGPT 可以访问的文件夹（可多选）" });
    const roots = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (roots.length > 0) {
      selectedRoots = uniqueRoots([...selectedRoots, ...roots]);
      renderSetupState();
    }
  } catch (error) {
    showSetupError(error);
  }
});

$("import-invite").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "选择管理员发来的搭手邀请文件",
      filters: [{ name: "搭手邀请", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    await invoke("import_invite", { path: selected });
    accessReady = true;
    await loadSetupState();
  } catch (error) {
    showSetupError(error);
  }
});

$("restart-daemon").addEventListener("click", async () => {
  if (restarting) return;
  restarting = true;
  $("restart-daemon").disabled = true;
  $("message").textContent = "正在恢复搭手…";
  try {
    await invoke("take_over_daemon");
    await invoke("start_daemon");
    await refresh();
    $("message").textContent = "搭手已经重新准备好。";
  } catch (error) {
    showReadyFailure(error);
  } finally {
    restarting = false;
    $("restart-daemon").disabled = false;
  }
});

$("reconfigure").addEventListener("click", async () => {
  configuring = true;
  await invoke("stop_daemon");
  const existing = await invoke("configuration");
  if (existing) {
    selectedRoots = uniqueRoots(existing.allowedRoots || []);
    accessReady = Boolean(existing.hasPilotToken);
  }
  setup.classList.remove("hidden");
  ready.classList.add("hidden");
  renderSetupState();
});

$("copy-code").addEventListener("click", async () => {
  try {
    const code = await invoke("connection_code");
    if (!code) {
      $("message").textContent = "尚未生成连接密码。";
      return;
    }
    await writeText(code, { label: "Dashou 连接密码" });
    $("message").textContent = "授权密码已复制，请在 ChatGPT 授权页粘贴。";
  } catch (error) {
    $("message").textContent = "授权密码没有复制成功，请再试一次。";
  }
});

async function copyMcpAddress() {
  if (!currentMcpUrl) {
    $("message").textContent = "连接还没有准备好。";
    return false;
  }
  try {
    await writeText(currentMcpUrl, { label: "Dashou MCP 地址" });
    $("message").textContent = "连接地址已复制。";
    return true;
  } catch {
    $("message").textContent = "连接地址没有复制成功，请再试一次。";
    return false;
  }
}

$("copy-address").addEventListener("click", () => { void copyMcpAddress(); });

$("connect-chatgpt").addEventListener("click", async () => {
  if (!(await copyMcpAddress())) return;
  try {
    await openExternal(CHATGPT_APPS_URL);
    $("message").textContent = "ChatGPT 已打开：点击“+”并粘贴地址。需要密码时，回到这里点击“复制授权密码”；若看不到“+”，请在 ChatGPT 设置 → 安全与登录中开启开发者模式。";
  } catch {
    $("message").textContent = "ChatGPT 没有打开，请稍后再试。";
  }
});

$("check-update").addEventListener("click", async () => {
  $("message").textContent = "正在检查更新…";
  await checkAndInstallUpdate();
});

refresh().catch((error) => {
  showSetupError(error);
  setup.classList.remove("hidden");
});

// Keep the installed app current without requiring the user to remember a
// manual upgrade step. Background failures stay silent and are retried later;
// the explicit button remains available for diagnostics.
void checkAndInstallUpdate({ silent: true });
setInterval(() => { void checkAndInstallUpdate({ silent: true }); }, UPDATE_INTERVAL_MS);
setInterval(() => { void refresh().catch((error) => {
  $("connect-chatgpt").disabled = true;
  $("status-dot").className = "dot bad";
  $("status-text").textContent = "搭手需要恢复";
  $("ready-copy").textContent = friendlyError(error);
  $("restart-daemon").classList.remove("hidden");
}); }, 5_000);
