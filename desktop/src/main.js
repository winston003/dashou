import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./styles.css";

const $ = (id) => document.getElementById(id);
const setup = $("setup");
const ready = $("ready");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updatePromise;

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
  const current = await invoke("status");
  $("app-version").textContent = current.version ? "v" + current.version : "";
  $("version").textContent = current.version || "—";
  $("connection-code").textContent = current.connectionCode || "—";
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
  $("status-text").textContent = actual.running ? "搭手正在运行" : "搭手尚未运行";
  $("ready-copy").textContent = actual.running
    ? "现在可以去 ChatGPT 完成 OAuth 连接。"
    : (actual.error || "点击重新设置或重启应用。");
  $("status-dot").className = "dot " + (actual.running ? "ok" : "bad");
}

$("save-start").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    const roots = $("roots").value.split(",").map((value) => value.trim()).filter(Boolean);
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

$("reconfigure").addEventListener("click", async () => {
  await invoke("stop_daemon");
  setup.classList.remove("hidden");
  ready.classList.add("hidden");
});

$("copy-code").addEventListener("click", async () => {
  const code = await invoke("connection_code");
  if (!code) {
    $("message").textContent = "尚未生成连接码。";
    return;
  }
  await navigator.clipboard.writeText(code);
  $("message").textContent = "连接码已复制。请在 ChatGPT 授权页粘贴。";
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
