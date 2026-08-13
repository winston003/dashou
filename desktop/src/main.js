import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./styles.css";

const $ = (id) => document.getElementById(id);
const setup = $("setup");
const ready = $("ready");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updatePromise;
let refreshPromise;
let currentMcpUrl;

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
      if (!silent) $("message").textContent = "更新失败：" + String(error);
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
    $("version").textContent = current.version || "—";
    if (!current.configured) {
      setup.classList.remove("hidden");
      ready.classList.add("hidden");
      return;
    }
    if (!current.running) {
      try {
        await invoke("start_daemon");
      } catch (error) {
        setup.classList.add("hidden");
        ready.classList.remove("hidden");
        $("status-dot").className = "dot bad";
        $("status-text").textContent = "搭手未启动";
        $("ready-copy").textContent = String(error);
        return;
      }
    }
    const actual = await invoke("status");
    setup.classList.add("hidden");
    ready.classList.remove("hidden");
    $("mcp-url").textContent = actual.mcpUrl || "—";
    currentMcpUrl = actual.mcpUrl || undefined;
    $("local-health").textContent = actual.localHealth ? "正常" : "不可用";
    $("public-health").textContent = actual.publicHealth ? "正常" : "等待连接";
    $("proxy").textContent = actual.proxy || "未检测到系统代理";
    const readyForChatGPT = actual.running && actual.localHealth && actual.publicHealth;
    const localOnly = actual.running && actual.localHealth;
    $("status-text").textContent = readyForChatGPT
      ? "可以连接 ChatGPT"
      : localOnly
        ? "正在等待公网连接"
        : actual.running
          ? "本地服务不可用"
          : "搭手尚未运行";
    $("ready-copy").textContent = readyForChatGPT
      ? "搭手已准备好。点击下方按钮复制连接密码，再去 ChatGPT 完成连接。"
      : localOnly
        ? "本地服务正常，但公网入口还没有响应；请检查网络或 Tunnel。"
        : actual.error || "正在检查本地服务。";
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
  try {
    const roots = $("roots").value ? [$("roots").value.trim()] : [];
    await invoke("configure", {
      settings: {
        allowedRoots: roots,
        publicBaseUrl: $("public-url").value.trim(),
        pilotToken: $("pilot-token").value.trim(),
        tunnelToken: $("tunnel-token").value.trim() || null,
        port: 7677,
      },
    });
    await invoke("start_daemon");
    $("tunnel-token").value = "";
    $("pilot-token").value = "";
    await refresh();
  } catch (error) {
    $("setup-error").textContent = String(error);
  }
});

$("choose-folder").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    const selected = await open({ directory: true, multiple: false, title: "选择 ChatGPT 可以访问的文件夹" });
    if (typeof selected === "string") $("roots").value = selected;
  } catch (error) {
    $("setup-error").textContent = String(error);
  }
});

$("reconfigure").addEventListener("click", async () => {
  await invoke("stop_daemon");
  setup.classList.remove("hidden");
  ready.classList.add("hidden");
});

$("copy-code").addEventListener("click", async () => {
  const code = await invoke("connection_code");
  if (!code) {
    $("message").textContent = "尚未生成连接密码。";
    return;
  }
  await navigator.clipboard.writeText(code);
  $("message").textContent = "连接密码已复制。请在 ChatGPT 授权页粘贴。";
});

async function copyMcpAddress() {
  if (!currentMcpUrl) {
    $("message").textContent = "公网连接还没有准备好。";
    return false;
  }
  await navigator.clipboard.writeText(currentMcpUrl);
  $("message").textContent = "连接地址已复制。";
  return true;
}

$("copy-address").addEventListener("click", () => { void copyMcpAddress(); });

$("connect-chatgpt").addEventListener("click", async () => {
  if (!(await copyMcpAddress())) return;
  await openExternal("https://chatgpt.com/");
  $("message").textContent = "地址已复制，ChatGPT 已打开。请在连接设置中粘贴地址并完成授权。";
});

$("check-update").addEventListener("click", async () => {
  $("message").textContent = "正在检查更新…";
  await checkAndInstallUpdate();
});

refresh().catch((error) => {
  $("setup-error").textContent = String(error);
  setup.classList.remove("hidden");
});

// Keep the installed app current without requiring the user to remember a
// manual upgrade step. Background failures stay silent and are retried later;
// the explicit button remains available for diagnostics.
void checkAndInstallUpdate({ silent: true });
setInterval(() => { void checkAndInstallUpdate({ silent: true }); }, UPDATE_INTERVAL_MS);
setInterval(() => { void refresh().catch((error) => {
  $("status-dot").className = "dot bad";
  $("status-text").textContent = "搭手状态检查失败";
  $("ready-copy").textContent = String(error);
}); }, 5_000);
