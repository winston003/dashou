import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import "./styles.css";

const $ = (id) => document.getElementById(id);
const setup = $("setup");
const ready = $("ready");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PENDING_SINCE_KEY = "dashou-pending-since";
const CHATGPT_APPS_URL = "https://chatgpt.com/plugins?view=personal";
let updatePromise;
let availableUpdate;
let updateReadyToRestart = false;
let refreshPromise;
let currentMcpUrl;
let configuring = false;
let accessReady = false;
let accessState = { status: "not_applied" };
let applying = false;
let selectedRoots = [];
let restarting = false;
let savedRootsBeforeEditing = [];
let hasSavedConfiguration = false;
let applicationStatusFailureRecorded = false;
let activationRecorded = false;
let runtimeStartFailed = false;
let runtimeHealthRecorded = false;
let runtimeAutoStartAttempted = false;
let copyMessages = {};
let lastAccessStatus = "not_applied";
let notifyWhenReady = localStorage.getItem("dashou-notify-ready") === "yes";

function copy(key, fallback) {
  return copyMessages[key] || fallback;
}

function applyCopyMessages(messages) {
  copyMessages = messages && typeof messages === "object" ? messages : {};
  for (const element of document.querySelectorAll("[data-copy]")) {
    const value = copyMessages[element.dataset.copy];
    if (typeof value === "string" && value.trim()) element.textContent = value;
  }
}

async function loadCopy({ checkRemote = false } = {}) {
  try {
    const bundle = await invoke(checkRemote ? "check_copy_update" : "copy_bundle");
    applyCopyMessages(bundle.messages);
  } catch {
    // The built-in wording is always available offline.
  }
}

async function confirmUiReady() {
  try {
    const loadedFromDownloadedUi = location.protocol === "dashou-ui:"
      || location.hostname === "dashou-ui.localhost";
    if (!loadedFromDownloadedUi) return;
    const bundle = await invoke("ui_bundle_status");
    if (bundle.source === "downloaded" && bundle.version) {
      await invoke("ui_ready", { version: bundle.version });
    }
  } catch {
    // The shell will roll back this UI on the next launch if it cannot confirm readiness.
  }
}

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

function diagnosticErrorCode(error) {
  return /\[([A-Z0-9_]{3,48})\]/.exec(errorText(error))?.[1] || "CLIENT_UNKNOWN";
}

function clearAccessError() {
  $("access-error").textContent = "";
  $("diagnostic-status").textContent = "";
  $("access-feedback").classList.add("hidden");
}

function showAccessError(error) {
  const code = diagnosticErrorCode(error);
  const messages = {
    CONTROL_TIMEOUT: "连接超时了。请检查网络后重新尝试。",
    CONTROL_CONNECT: "暂时联系不到搭手服务。请检查网络后重新尝试。",
    CONTROL_RESPONSE_INVALID: "搭手服务返回了异常结果，请稍后重试。",
  };
  $("access-error").textContent = messages[code]
    || copy("failureBody", code.startsWith("CONTROL_HTTP_") ? "我们暂时没能完成准备，请稍后再试一次。" : "可能是网络暂时不稳定。你可以重新试一次；如果仍然不行，把排查信息发给我们。");
  $("access-feedback").classList.remove("hidden");
}

async function recordEvent(stage, outcome = "ok", errorCode, applicationId) {
  try {
    await invoke("record_client_event", { stage, outcome, errorCode: errorCode || null, applicationId: applicationId || null });
  } catch {
    // Diagnostics must never interrupt the user's primary action.
  }
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
  $("folder-step").classList.toggle("hidden", !accessReady);
  $("setup-title").textContent = accessReady
    ? copy("readyTitle", "搭手已经准备好了")
    : copy("setupTitle", "让这台电脑用上搭手");
  $("setup-intro").textContent = accessReady
    ? copy("readyBody", "现在请选择你愿意让 ChatGPT 使用的文件夹。没有选择的文件夹不会出现在搭手中。")
    : copy("setupIntro", "目前是小范围试用。我们会先确认当前名额；有名额后，搭手会自动为这台电脑做好准备。");
  const progress = $("access-progress");
  progress.classList.toggle("hidden", !["pending", "provisioning"].includes(status));
  $("progress-prepare").className = status === "pending" ? "active" : "done";
  $("progress-check").className = status === "provisioning" ? "active" : "";
  $("progress-done").className = "";
  $("notify-ready").textContent = notifyWhenReady ? "准备好后会提醒你" : "准备好后提醒我";
  const isWaiting = ["pending", "provisioning"].includes(status);
  const serverCreatedAt = Date.parse(accessState?.createdAt || accessState?.created_at || "");
  let pendingSince = Number(localStorage.getItem(PENDING_SINCE_KEY));
  if (isWaiting && Number.isFinite(serverCreatedAt)) {
    pendingSince = serverCreatedAt;
    localStorage.setItem(PENDING_SINCE_KEY, String(serverCreatedAt));
  } else if (isWaiting && !Number.isFinite(pendingSince)) {
    pendingSince = Date.now();
    localStorage.setItem(PENDING_SINCE_KEY, String(pendingSince));
  } else if (!isWaiting) {
    localStorage.removeItem(PENDING_SINCE_KEY);
  }
  const waitingLong = isWaiting && Number.isFinite(pendingSince) && Date.now() - pendingSince > 5 * 60 * 1000;
  $("access-wait-copy").textContent = notifyWhenReady
    ? "你可以关闭窗口。准备好后，系统会提醒你回来继续。"
    : waitingLong
      ? copy("trialSlow", "这次准备得比平时久一些。你可以重新检查；关闭窗口也不会中断准备。")
      : "通常几分钟内会有结果。你可以关闭窗口，下次打开时继续查看。";
  if (accessReady) {
    accessStatus.textContent = copy("readyTitle", "搭手已经准备好了");
    accessStatus.className = "setup-status ready";
    applyButton.textContent = "已开通";
    applyButton.disabled = true;
  } else if (["pending", "provisioning"].includes(status)) {
    accessStatus.textContent = status === "provisioning"
      ? copy("trialProvisioningTitle", "正在为这台电脑准备搭手")
      : copy("trialPendingTitle", "已经收到，正在确认试用名额");
    accessStatus.className = "setup-status waiting";
    applyButton.textContent = "正在准备";
    applyButton.disabled = true;
  } else if (status === "rejected") {
    accessStatus.textContent = accessState.reason || "这次暂时没有合适的试用名额";
    accessStatus.className = "setup-status";
    applyButton.textContent = "再试一次";
    applyButton.disabled = applying;
  } else if (["expired", "revoked"].includes(status)) {
    accessStatus.textContent = status === "expired" ? "这段试用已经结束" : "这台电脑目前没有使用名额";
    accessStatus.className = "setup-status";
    applyButton.textContent = "再次加入";
    applyButton.disabled = applying;
  } else {
    accessStatus.textContent = applying ? "正在告诉我们" : copy("trialIdle", "还没有加入");
    accessStatus.className = applying ? "setup-status waiting" : "setup-status";
    applyButton.textContent = applying ? "正在发送…" : copy("joinTrial", "加入试用");
    applyButton.disabled = applying;
  }
  $("save-start").disabled = !(accessReady && hasRoots);
  $("cancel-setup").classList.toggle("hidden", !hasSavedConfiguration);
  renderRoots();
}

async function loadSetupState() {
  let existing = await invoke("configuration");
  hasSavedConfiguration = Boolean(existing);
  if (existing) {
    if (selectedRoots.length === 0) selectedRoots = uniqueRoots(existing.allowedRoots || []);
    accessReady = Boolean(existing.hasPilotToken);
  }
  try {
    accessState = await invoke("application_status");
    applicationStatusFailureRecorded = false;
    if (accessState.status === "activated") {
      if (!activationRecorded) {
        activationRecorded = true;
        void recordEvent("activation_completed", "ok", null, accessState.applicationId);
      }
      existing = await invoke("configuration");
      accessReady = Boolean(existing?.hasPilotToken);
      if (lastAccessStatus !== "activated" && notifyWhenReady) {
        try {
          if (await isPermissionGranted()) sendNotification({ title: "搭手已经准备好了", body: "回来选择你愿意使用的文件夹，就可以继续。" });
        } catch {}
      }
    } else if (accessState.status !== "not_applied") {
      accessReady = false;
    }
  } catch (error) {
    if (!accessReady && !["pending", "provisioning"].includes(accessState.status)) {
      if (!$("access-error").textContent.trim()) showAccessError(error);
      if (!applicationStatusFailureRecorded) {
        applicationStatusFailureRecorded = true;
        void recordEvent("application_status_failed", "error", diagnosticErrorCode(error), accessState.applicationId);
      }
    }
  }
  lastAccessStatus = accessState.status;
  renderSetupState();
}

async function checkForUpdate({ silent = false } = {}) {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    try {
      const update = await check();
      if (!update) {
        if (!silent) $("message").textContent = "当前已经是最新版本。";
        return false;
      }
      availableUpdate = update;
      $("check-update").textContent = "安装更新";
      $("message").textContent = `发现新版本 ${update.version}。准备好后点击“安装更新”，不会打断当前操作。`;
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

async function installAvailableUpdate() {
  if (updateReadyToRestart) {
    await relaunch();
    return;
  }
  if (!availableUpdate) {
    const found = await checkForUpdate();
    if (!found) return;
  }
  if (configuring || applying || restarting) {
    $("message").textContent = "当前操作完成后再安装更新。";
    return;
  }
  $("check-update").disabled = true;
  $("message").textContent = `正在准备 ${availableUpdate.version}…`;
  try {
    await availableUpdate.downloadAndInstall();
    updateReadyToRestart = true;
    $("check-update").textContent = "重新启动完成更新";
    $("message").textContent = "更新已准备好。完成当前工作后，点击按钮重新启动。";
  } catch {
    $("message").textContent = "更新没有完成，请稍后再试。";
  } finally {
    $("check-update").disabled = false;
  }
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
    if (!current.running && !runtimeStartFailed && !runtimeAutoStartAttempted) {
      runtimeAutoStartAttempted = true;
      try {
        await invoke("start_daemon");
      } catch (error) {
        runtimeStartFailed = true;
        showReadyFailure(error);
        return;
      }
    }
    const actual = await invoke("status");
    if (runtimeAutoStartAttempted && !actual.running) runtimeStartFailed = true;
    setup.classList.add("hidden");
    ready.classList.remove("hidden");
    currentMcpUrl = actual.mcpUrl || undefined;
    const readyForChatGPT = actual.running && actual.localHealth && actual.publicHealth;
    const localOnly = actual.running && actual.localHealth;
    if (actual.localHealth && !runtimeHealthRecorded) {
      runtimeHealthRecorded = true;
      void recordEvent("runtime_started", "ok", null, accessState.applicationId);
    }
    $("connect-chatgpt").disabled = !readyForChatGPT;
    $("restart-daemon").classList.toggle("hidden", actual.running || actual.localHealth);
    $("status-text").textContent = readyForChatGPT
      ? "可以连接 ChatGPT"
      : localOnly
        ? "正在建立连接"
        : actual.running
          ? "搭手正在启动"
          : "搭手尚未准备好";
    $("ready-copy").textContent = readyForChatGPT
      ? "搭手已准备好。下方按钮会复制连接地址，并直接打开 ChatGPT 的添加页面。"
      : localOnly
        ? "搭手已经启动，正在完成最后的连接。"
        : actual.running
          ? "搭手正在启动，通常只需要几秒钟。"
          : "搭手没有正常启动，请点击“重新启动”再试。";
    $("status-dot").className = "dot " + (readyForChatGPT ? "ok" : actual.running ? "warn" : "bad");
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
  void recordEvent("runtime_start_started");
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
    hasSavedConfiguration = true;
    await invoke("take_over_daemon");
    runtimeStartFailed = false;
    runtimeHealthRecorded = false;
    runtimeAutoStartAttempted = true;
    await invoke("start_daemon");
    configuring = false;
    await refresh();
  } catch (error) {
    void recordEvent("runtime_start_failed", "error", diagnosticErrorCode(error), accessState.applicationId);
    configuring = false;
    if (saved) showReadyFailure(error);
    else showSetupError(error);
  }
});

$("apply-access").addEventListener("click", async () => {
  if (applying || accessReady) return;
  applying = true;
  $("setup-error").textContent = "";
  clearAccessError();
  void recordEvent("application_submit_started");
  renderSetupState();
  try {
    accessState = await invoke("apply_for_access");
    void recordEvent("application_submitted", "ok", null, accessState.applicationId);
  } catch (error) {
    showAccessError(error);
    void recordEvent("application_submit_failed", "error", diagnosticErrorCode(error));
  } finally {
    applying = false;
    renderSetupState();
  }
});

async function refreshAccessNow() {
  clearAccessError();
  try {
    await loadSetupState();
  } catch (error) {
    showAccessError(error);
  }
}

$("refresh-access").addEventListener("click", () => { void refreshAccessNow(); });
$("retry-access").addEventListener("click", () => { void $("apply-access").click(); });

$("notify-ready").addEventListener("click", async () => {
  if (notifyWhenReady) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) {
      notifyWhenReady = true;
      localStorage.setItem("dashou-notify-ready", "yes");
      $("notify-ready").textContent = "准备好后会提醒你";
      $("access-wait-copy").textContent = "你可以关闭窗口。准备好后，系统会提醒你回来继续。";
    } else {
      $("access-wait-copy").textContent = "没有开启提醒也没关系。你可以关闭窗口，下次打开搭手时继续查看。";
    }
  } catch {
    $("access-wait-copy").textContent = "这次没能开启提醒。你可以关闭窗口，下次打开搭手时继续查看。";
  }
});

$("choose-folder").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    const selected = await open({ directory: true, multiple: true, title: "选择 ChatGPT 可以访问的文件夹（可多选）" });
    const roots = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (roots.length > 0) {
      selectedRoots = uniqueRoots([...selectedRoots, ...roots]);
      void recordEvent("folders_selected");
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
    runtimeStartFailed = false;
    runtimeHealthRecorded = false;
    runtimeAutoStartAttempted = true;
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
  savedRootsBeforeEditing = [...selectedRoots];
  configuring = true;
  const existing = await invoke("configuration");
  hasSavedConfiguration = Boolean(existing);
  if (existing) {
    selectedRoots = uniqueRoots(existing.allowedRoots || []);
    accessReady = Boolean(existing.hasPilotToken);
  }
  setup.classList.remove("hidden");
  ready.classList.add("hidden");
  renderSetupState();
});

$("cancel-setup").addEventListener("click", async () => {
  selectedRoots = [...savedRootsBeforeEditing];
  configuring = false;
  setup.classList.add("hidden");
  ready.classList.remove("hidden");
  await refresh();
});

$("copy-code").addEventListener("click", async () => {
  try {
    const code = await invoke("connection_code");
    if (!code) {
      $("message").textContent = "尚未生成连接密码。";
      return;
    }
    await writeText(code, { label: "Dashou 连接密码" });
    void recordEvent("connection_password_copied");
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
    void recordEvent("chatgpt_opened");
    $("message").textContent = "ChatGPT 已打开：在“个人”页点击“创建应用”并粘贴地址。需要密码时，回到这里点击“复制授权密码”；若看不到“创建应用”，请在 ChatGPT 设置 → 应用（Apps）→ 高级设置（Advanced settings）中开启开发者模式。";
  } catch {
    $("message").textContent = "ChatGPT 没有打开，请稍后再试。";
  }
});

$("copy-diagnostics").addEventListener("click", async () => {
  try {
    const report = await invoke("diagnostic_report");
    await writeText(JSON.stringify(report, null, 2), { label: "Dashou 排查信息" });
    $("diagnostic-status").textContent = "已复制，请发给我们。";
  } catch {
    $("diagnostic-status").textContent = "复制失败，请再试一次。";
  }
});

$("check-update").addEventListener("click", async () => {
  if (!availableUpdate && !updateReadyToRestart) $("message").textContent = "正在检查更新…";
  await installAvailableUpdate();
});

void recordEvent("app_opened");

await loadCopy();
await confirmUiReady();

refresh().catch((error) => {
  showSetupError(error);
  setup.classList.remove("hidden");
});

// Discover updates in the background, but never install or restart while the
// user is applying, choosing folders or starting the local service.
void checkForUpdate({ silent: true });
setTimeout(() => {
  if (!configuring && !applying && !restarting) {
    void loadCopy({ checkRemote: true });
    void invoke("check_ui_update").catch(() => {});
  }
}, 4_000);
setInterval(() => { void checkForUpdate({ silent: true }); }, UPDATE_INTERVAL_MS);
setInterval(() => {
  if (!configuring && !applying && !restarting) {
    void loadCopy({ checkRemote: true });
    void invoke("check_ui_update").catch(() => {});
  }
}, UPDATE_INTERVAL_MS);
setInterval(() => { void refresh().catch((error) => {
  $("connect-chatgpt").disabled = true;
  $("status-dot").className = "dot bad";
  $("status-text").textContent = "搭手需要恢复";
  $("ready-copy").textContent = friendlyError(error);
  $("restart-daemon").classList.remove("hidden");
}); }, 5_000);
