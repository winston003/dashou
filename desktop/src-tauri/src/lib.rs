use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

struct DaemonState(Mutex<Option<Child>>);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_windows_console(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

const CONTROL_BASE_URL: &str = "https://dashou-pilot-control.whilewon.workers.dev";
const LEGACY_PILOT_POLICY_URL: &str =
    "https://dashou-pilot-control.whilewon.workers.dev/pilot-policy";
const LEGACY_PILOT_POLICY_PUBLIC_KEY: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8nR2Lgof4hTe9ahqRATb
XZhB1W8atG8nQjmUmZ0ex6+KwubPVcdeFfngD1PCe8I/4EtyOMk9Q68I4X1w0kN0
g1sGhoC7teEsUW4HhgNxXNsw1wuLWps8RIBUy+VPKUwMqmBHn3EHyHC2DoVEZkV2
hkZGowqC5PoU5MJrHN671XHYTp4hShSjG5R4JM6XvfNIM+j+HdvR9gV3Og9YR0QH
CnV7X4Fsv34cquKbIeGemYmNA+haV4iZ6S6zB07EY3G+eSA4lrrrzrEv5JTlN1pD
U052we/MXg0gRacZ6IZluzRCu1ap07TJZAPAjo9eURQYKa3BfVcPu6cU4hevuauw
RQIDAQAB
-----END PUBLIC KEY-----"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    allowed_roots: Vec<String>,
    public_base_url: String,
    pilot_token: String,
    tunnel_token: Option<String>,
    port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    configured: bool,
    running: bool,
    version: String,
    mcp_url: Option<String>,
    local_health: bool,
    public_health: bool,
    proxy: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfiguration {
    allowed_roots: Vec<String>,
    public_base_url: String,
    has_pilot_token: bool,
    has_tunnel_token: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteFile {
    kind: String,
    version: u8,
    public_base_url: String,
    pilot_token: String,
    tunnel_token: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    host: String,
    port: u16,
    allowed_roots: Vec<String>,
    public_base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredAuth {
    owner_token: String,
    pilot_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tunnel_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pilot_policy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pilot_public_key_pem: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredApplication {
    control_base_url: String,
    device_id: String,
    application_token: String,
    application_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationApiStatus {
    application_id: String,
    status: String,
    created_at: Option<String>,
    period: Option<String>,
    expires_at: Option<String>,
    mcp_url: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessStatus {
    status: String,
    application_id: Option<String>,
    created_at: Option<String>,
    period: Option<String>,
    expires_at: Option<String>,
    mcp_url: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationResponse {
    public_base_url: String,
    mcp_url: String,
    tunnel_token: String,
    pilot_token: String,
    pilot_policy_url: String,
    pilot_public_key_pem: String,
    activation_receipt: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEvent {
    #[serde(default)]
    event_id: String,
    unix_seconds: u64,
    stage: String,
    outcome: String,
    app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    application_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    product: &'static str,
    app_version: String,
    platform: String,
    events: Vec<DiagnosticEvent>,
    privacy: &'static str,
}

const DIAGNOSTIC_STAGES: &[&str] = &[
    "app_opened",
    "application_submit_started",
    "application_submitted",
    "application_submit_failed",
    "application_status_failed",
    "activation_completed",
    "folders_selected",
    "runtime_start_started",
    "runtime_started",
    "runtime_start_failed",
    "chatgpt_opened",
    "connection_password_copied",
];

#[tauri::command]
fn record_client_event(
    app: AppHandle,
    stage: String,
    outcome: String,
    error_code: Option<String>,
    application_id: Option<String>,
) -> Result<(), String> {
    validate_diagnostic_event(
        &stage,
        &outcome,
        error_code.as_deref(),
        application_id.as_deref(),
    )?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    append_diagnostic_event(
        &data_dir,
        DiagnosticEvent {
            event_id: format!("evt_{}", generate_token()),
            unix_seconds: unix_seconds(),
            stage,
            outcome,
            app_version: env!("CARGO_PKG_VERSION").into(),
            error_code,
            application_id,
        },
    )
}

#[tauri::command]
fn diagnostic_report(app: AppHandle) -> Result<DiagnosticReport, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(build_diagnostic_report(&data_dir))
}

#[tauri::command]
async fn status(app: AppHandle, state: State<'_, DaemonState>) -> Result<DesktopStatus, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_path = data_dir.join("config").join("config.json");
    let config_dir = data_dir.join("config");
    let configured = configuration_is_ready(&config_path, &config_dir.join("auth.json"));
    let running = daemon_is_running(&state) || external_daemon_is_running(&data_dir.join("state"));
    let proxy = apply_system_proxy_environment();
    let (mcp_url, local_health, public_health) = if configured && running {
        let public_url = read_public_url(&config_path);
        let port = read_port(&config_path).unwrap_or(7677);
        let mcp_url = public_url
            .as_ref()
            .map(|url| format!("{}/mcp", url.trim_end_matches('/')));
        let local_health = probe_health(&format!("http://127.0.0.1:{port}/healthz")).await;
        let public_health = match public_url.as_deref() {
            Some(url) => probe_health(&format!("{}/healthz", url.trim_end_matches('/'))).await,
            None => false,
        };
        (mcp_url, local_health, public_health)
    } else {
        (None, false, false)
    };
    Ok(DesktopStatus {
        configured,
        running,
        version: env!("CARGO_PKG_VERSION").to_string(),
        mcp_url,
        local_health,
        public_health,
        proxy,
        error: None,
    })
}

#[tauri::command]
fn connection_code(app: AppHandle) -> Result<Option<String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(read_owner_token(&data_dir.join("config")))
}

#[tauri::command]
async fn apply_for_access(app: AppHandle) -> Result<AccessStatus, String> {
    apply_system_proxy_environment();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let application_path = config_dir.join("application.json");
    let mut application =
        read_application(&application_path).unwrap_or_else(|| StoredApplication {
            control_base_url: control_base_url(),
            device_id: format!("dev_{}", generate_token()),
            application_token: generate_token(),
            application_id: None,
        });
    // Persist the device credential before the request so a lost response can
    // be retried idempotently without orphaning a server-side application.
    write_json_atomic(&application_path, &application, true)?;
    let control_base_url = normalize_control_base_url(&application.control_base_url)?;
    let request_body = serde_json::json!({
        "deviceId": application.device_id,
        "applicationToken": application.application_token,
        "deviceName": device_name(),
        "platform": platform_name(),
    });
    let response: ApplicationApiStatus = control_request(
        reqwest::Method::POST,
        &format!("{control_base_url}/applications"),
        None,
        Some(request_body),
    )
    .await?;
    application.application_id = Some(response.application_id.clone());
    write_json_atomic(&application_path, &application, true)?;
    let _ = sync_diagnostic_events(&data_dir, &application).await;
    Ok(access_status(response))
}

#[tauri::command]
async fn application_status(app: AppHandle) -> Result<AccessStatus, String> {
    apply_system_proxy_environment();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    let application_path = config_dir.join("application.json");
    let Some(application) = read_application(&application_path) else {
        return Ok(AccessStatus {
            status: "not_applied".into(),
            application_id: None,
            created_at: None,
            period: None,
            expires_at: None,
            mcp_url: None,
            reason: None,
        });
    };
    let application_id = application
        .application_id
        .as_deref()
        .ok_or_else(|| "申请尚未成功提交，请重新点击申请".to_string())?;
    let base_url = normalize_control_base_url(&application.control_base_url)?;
    let mut response: ApplicationApiStatus = control_request(
        reqwest::Method::GET,
        &format!("{base_url}/applications/{application_id}"),
        Some(&application.application_token),
        None,
    )
    .await?;
    let _ = sync_diagnostic_events(&data_dir, &application).await;
    if response.status == "approved" {
        let activation: ActivationResponse = control_request(
            reqwest::Method::POST,
            &format!("{base_url}/applications/{application_id}/activate"),
            Some(&application.application_token),
            Some(serde_json::json!({})),
        )
        .await?;
        save_activation(&config_dir, &activation)?;
        let confirmed: ApplicationApiStatus = control_request(
            reqwest::Method::POST,
            &format!("{base_url}/applications/{application_id}/activate/confirm"),
            Some(&application.application_token),
            Some(serde_json::json!({ "activationReceipt": activation.activation_receipt })),
        )
        .await?;
        response = confirmed;
    }
    Ok(access_status(response))
}

#[tauri::command]
fn configuration(app: AppHandle) -> Result<Option<DesktopConfiguration>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_path = data_dir.join("config").join("config.json");
    let text = match fs::read_to_string(&config_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let config: StoredConfig = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "配置目录不存在".to_string())?;
    Ok(Some(DesktopConfiguration {
        allowed_roots: config.allowed_roots,
        public_base_url: config.public_base_url,
        has_pilot_token: read_pilot_token(config_dir).is_some(),
        has_tunnel_token: read_tunnel_token(config_dir).is_some(),
    }))
}

#[tauri::command]
fn import_invite(app: AppHandle, path: String) -> Result<(), String> {
    let text = fs::read_to_string(&path).map_err(|error| format!("无法读取邀请文件：{error}"))?;
    let invite: InviteFile =
        serde_json::from_str(&text).map_err(|error| format!("邀请文件格式不正确：{error}"))?;
    if invite.kind != "dashou-invite" || invite.version != 1 {
        return Err("这不是受支持的搭手邀请文件".into());
    }
    if invite.pilot_token.trim().len() < 16 {
        return Err("邀请文件缺少有效的内测授权".into());
    }
    let public_url = normalize_public_url(&invite.public_base_url)?;
    if !public_url.starts_with("https://") {
        return Err("管理员邀请必须使用 HTTPS 公网地址".into());
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let existing_config = read_stored_config(&config_dir.join("config.json"));
    let owner_token = read_owner_token(&config_dir).unwrap_or_else(generate_token);
    let tunnel_token = invite.tunnel_token.filter(|token| !token.trim().is_empty());
    write_json_atomic(
        &config_dir.join("config.json"),
        &StoredConfig {
            host: "127.0.0.1".into(),
            port: existing_config
                .as_ref()
                .map(|config| config.port)
                .unwrap_or(7677),
            allowed_roots: existing_config
                .map(|config| config.allowed_roots)
                .unwrap_or_default(),
            public_base_url: public_url,
        },
        false,
    )?;
    write_json_atomic(
        &config_dir.join("auth.json"),
        &StoredAuth {
            owner_token,
            pilot_token: invite.pilot_token.trim().to_string(),
            tunnel_token,
            pilot_policy_url: Some(LEGACY_PILOT_POLICY_URL.into()),
            pilot_public_key_pem: Some(LEGACY_PILOT_POLICY_PUBLIC_KEY.into()),
        },
        true,
    )?;
    clear_application_record(&config_dir)?;
    Ok(())
}

#[tauri::command]
fn configure(app: AppHandle, settings: DesktopSettings) -> Result<(), String> {
    if settings.allowed_roots.is_empty() {
        return Err("至少需要一个授权目录".into());
    }
    if settings
        .allowed_roots
        .iter()
        .any(|root| !Path::new(root).is_absolute())
    {
        return Err("授权目录必须使用绝对路径".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let pilot_token = if settings.pilot_token.trim().is_empty() {
        read_pilot_token(&config_dir).ok_or_else(|| "内测连接码不能为空".to_string())?
    } else {
        settings.pilot_token
    };
    let public_url = if settings.public_base_url.trim().is_empty() {
        read_public_url(&config_dir.join("config.json"))
            .ok_or_else(|| "公网地址不能为空".to_string())?
    } else {
        normalize_public_url(&settings.public_base_url)?
    };
    let owner_token = read_owner_token(&config_dir).unwrap_or_else(generate_token);
    let tunnel_token = settings
        .tunnel_token
        .filter(|token| !token.trim().is_empty())
        .or_else(|| read_tunnel_token(&config_dir));
    let pilot_policy_url =
        read_pilot_policy_url(&config_dir).or_else(|| Some(LEGACY_PILOT_POLICY_URL.into()));
    let pilot_public_key_pem =
        read_pilot_public_key(&config_dir).or_else(|| Some(LEGACY_PILOT_POLICY_PUBLIC_KEY.into()));
    write_json_atomic(
        &config_dir.join("config.json"),
        &StoredConfig {
            host: "127.0.0.1".into(),
            port: settings.port,
            allowed_roots: settings.allowed_roots,
            public_base_url: public_url,
        },
        false,
    )?;
    write_json_atomic(
        &config_dir.join("auth.json"),
        &StoredAuth {
            owner_token,
            pilot_token,
            tunnel_token,
            pilot_policy_url,
            pilot_public_key_pem,
        },
        true,
    )?;
    Ok(())
}

#[tauri::command]
fn start_daemon(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    apply_system_proxy_environment();
    let mut guard = state.0.lock().map_err(|_| "后台服务状态锁已损坏")?;
    if let Some(child) = guard.as_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Ok(());
        }
        *guard = None;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    if !config_dir.join("config.json").exists() || !config_dir.join("auth.json").exists() {
        return Err("请先完成第一次设置".into());
    }
    match live_lock_owner(&data_dir.join("state")) {
        Some(LiveLockOwner::Dashou(pid)) => {
            return Err(format!("DASHOU_ALREADY_RUNNING:{pid}"));
        }
        Some(LiveLockOwner::Other | LiveLockOwner::Unknown) => {
            return Err("DASHOU_OTHER_PROCESS".into());
        }
        None => {}
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    // Tauri preserves `../vendor/...` under `_up_/vendor/...` in bundled
    // resources on some targets. Resolve both the intended flat layout and
    // the layout produced by the bundler so an installed app can start with
    // the exact resources that were packaged into it.
    let resource_root = locate_resource_root(&resource_dir);
    let node = resource_root.join("node-runtime").join(node_name());
    let cli = resource_root
        .join("dashou-runtime")
        .join("dist")
        .join("dashou-cli.js");
    let cloudflared = resource_root.join("cloudflared").join(cloudflared_name());
    for required in [&node, &cli, &cloudflared] {
        if !required.exists() {
            return Err(format!("安装包缺少运行资源：{}", required.display()));
        }
    }
    let runtime_dir = resource_root.join("dashou-runtime");
    let runtime_bin = node.parent().unwrap_or(Path::new(""));
    let path = format!(
        "{}{}{}",
        runtime_bin.display(),
        path_separator(),
        std::env::var("PATH").unwrap_or_default()
    );
    let pilot_token = read_pilot_token(&config_dir).unwrap_or_default();
    let pilot_policy_url =
        read_pilot_policy_url(&config_dir).unwrap_or_else(|| LEGACY_PILOT_POLICY_URL.into());
    let pilot_public_key =
        read_pilot_public_key(&config_dir).unwrap_or_else(|| LEGACY_PILOT_POLICY_PUBLIC_KEY.into());
    let log_path = data_dir.join("logs").join("runtime.log");
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("无法打开后台运行日志：{error}"))?;
    set_private_file(&log_path)?;
    let log_file_for_stdout = log_file
        .try_clone()
        .map_err(|error| format!("无法准备后台运行日志：{error}"))?;
    let mut command = Command::new(node);
    command
        // The bundled Node 22 runtime supports this flag. Proxy environment
        // variables are filled from the OS settings immediately before spawn.
        .arg("--use-env-proxy")
        .arg(cli)
        .arg("serve")
        .current_dir(runtime_dir)
        .env("DASHOU_CONFIG_DIR", &config_dir)
        .env("DASHOU_STATE_DIR", data_dir.join("state"))
        .env("DASHOU_TRUST_PROXY", "1")
        .env("DASHOU_PILOT_POLICY_URL", pilot_policy_url)
        .env("DASHOU_PILOT_POLICY_PUBLIC_KEY", pilot_public_key)
        .env("DASHOU_PILOT_POLICY_TOKEN", pilot_token)
        .env("DASHOU_CLOUDFLARED_PATH", cloudflared)
        .env("DASHOU_EMBEDDED_RUNTIME", "1")
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file_for_stdout))
        .stderr(Stdio::from(log_file));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW | 0x00000200);
    }
    #[cfg(unix)]
    unsafe {
        // Keep the Node service and the cloudflared child in one process
        // group so closing Dashou cannot leave the Tunnel behind.
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动搭手服务：{error}"))?;
    // A successful spawn only proves that the process was created. Check once
    // after startup so a configuration/runtime error cannot leave the UI
    // claiming that Dashou is running while port 7677 is already dead.
    thread::sleep(Duration::from_millis(350));
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("无法确认搭手服务状态：{error}"))?
    {
        return Err(format!(
            "搭手服务启动后立即退出（{}）。运行日志：{}",
            status,
            log_path.display()
        ));
    }
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_daemon(state: State<'_, DaemonState>) -> Result<(), String> {
    stop_child(&state)
}

/// Take over only a process that is proven to be the Dashou service for this
/// app-data directory. An unknown process is never stopped automatically.
#[tauri::command]
fn take_over_daemon(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    stop_child(&state)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let state_dir = data_dir.join("state");
    let Some(pid) = (match live_lock_owner(&state_dir) {
        Some(LiveLockOwner::Dashou(pid)) => Some(pid),
        Some(LiveLockOwner::Other | LiveLockOwner::Unknown) => {
            return Err("发现其他程序占用了搭手服务，出于安全原因没有停止它".into());
        }
        None => None,
    }) else {
        return Ok(());
    };

    terminate_external_daemon(pid)?;
    if process_is_alive(pid) {
        return Err("搭手没有完全退出，请稍后再试".into());
    }
    Ok(())
}

fn daemon_is_running(state: &State<'_, DaemonState>) -> bool {
    let Ok(mut guard) = state.0.lock() else {
        return false;
    };
    let Some(child) = guard.as_mut() else {
        return false;
    };
    match child.try_wait() {
        Ok(None) => true,
        Ok(Some(_)) | Err(_) => {
            *guard = None;
            false
        }
    }
}

fn stop_child(state: &State<'_, DaemonState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "后台服务状态锁已损坏")?;
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        #[cfg(unix)]
        {
            // The child is the leader of its own process group. Shut down the
            // group gracefully first, then force-kill only that group if a
            // descendant does not exit promptly.
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            if child.try_wait().ok().flatten().is_none() {
                unsafe {
                    libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                }
            }
        }
        #[cfg(windows)]
        {
            // Child::kill() does not include descendants on Windows. taskkill
            // tree mode is the smallest reliable equivalent for this bundle.
            let mut taskkill = Command::new("taskkill");
            hide_windows_console(&mut taskkill);
            let _ = taskkill
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.wait();
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum LiveLockOwner {
    Dashou(u32),
    Other,
    Unknown,
}

fn external_daemon_is_running(state_dir: &Path) -> bool {
    matches!(live_lock_owner(state_dir), Some(LiveLockOwner::Dashou(_)))
}

fn live_lock_owner(state_dir: &Path) -> Option<LiveLockOwner> {
    let lock_path = state_dir.join("serve.lock");
    let pid_path = lock_path.join("pid");
    let pid = fs::read_to_string(pid_path)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)?;
    if !process_is_alive(pid) {
        return None;
    }
    match process_command(pid) {
        Some(command) if is_dashou_serve_command(&command) => Some(LiveLockOwner::Dashou(pid)),
        Some(_) => Some(LiveLockOwner::Other),
        None => Some(LiveLockOwner::Unknown),
    }
}

fn is_dashou_serve_command(command: &str) -> bool {
    let normalized = command.replace('\\', "/");
    let tokens: Vec<String> = normalized
        .split_whitespace()
        .map(|token| token.trim_matches(['"', '\'']).to_string())
        .collect();
    let Some(executable) = tokens.first().and_then(|token| token.rsplit('/').next()) else {
        return false;
    };
    if !executable.eq_ignore_ascii_case("node") && !executable.eq_ignore_ascii_case("node.exe") {
        return false;
    }
    tokens.windows(2).any(|pair| {
        let entry = pair[0].rsplit('/').next().unwrap_or_default();
        entry.eq_ignore_ascii_case("dashou-cli.js") && pair[1] == "serve"
    })
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        return result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(windows)]
    {
        let mut tasklist = Command::new("tasklist");
        hide_windows_console(&mut tasklist);
        return tasklist
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .stderr(Stdio::null())
            .output()
            .map(|output| output.status.success() && tasklist_contains_pid(&output.stdout, pid))
            .unwrap_or(false);
    }
}

#[cfg(any(windows, test))]
fn tasklist_contains_pid(output: &[u8], pid: u32) -> bool {
    let expected = pid.to_string();
    String::from_utf8_lossy(output).lines().any(|line| {
        let mut fields = line.trim().trim_matches('"').split("\",\"");
        let _image_name = fields.next();
        fields.next() == Some(expected.as_str())
    })
}

fn process_command(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!command.is_empty()).then_some(command);
    }
    #[cfg(windows)]
    {
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" | ForEach-Object {{ $_.CommandLine }}"
        );
        let mut powershell = Command::new("powershell.exe");
        hide_windows_console(&mut powershell);
        let output = powershell
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!command.is_empty()).then_some(command);
    }
}

fn terminate_external_daemon(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let process_group = process_group_id(pid);
        let signal_target = if process_group == Some(pid) {
            -(pid as libc::pid_t)
        } else {
            pid as libc::pid_t
        };
        let result = unsafe { libc::kill(signal_target, libc::SIGTERM) };
        if result != 0 && process_is_alive(pid) {
            return Err("无法重新启动搭手，请稍后再试".into());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        if process_is_alive(pid) {
            let result = unsafe { libc::kill(signal_target, libc::SIGKILL) };
            if result != 0 && process_is_alive(pid) {
                return Err("搭手没有完全退出，请稍后再试".into());
            }
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill");
        hide_windows_console(&mut taskkill);
        let status = taskkill
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "无法重新启动搭手，请稍后再试".to_string())?;
        if !status.success() && process_is_alive(pid) {
            return Err("无法重新启动搭手，请稍后再试".into());
        }
        return Ok(());
    }
}

#[cfg(unix)]
fn process_group_id(pid: u32) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pgid="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn read_public_url(path: &Path) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    value.get("publicBaseUrl")?.as_str().map(str::to_string)
}

fn read_port(path: &Path) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    value
        .get("port")?
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
}

async fn probe_health(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let Ok(response) = client.get(url).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.text().await else {
        return false;
    };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };
    payload.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && payload.get("name").and_then(serde_json::Value::as_str) == Some("dashou")
}

#[derive(Clone, Debug, Default)]
struct ProxySettings {
    http: Option<String>,
    https: Option<String>,
    no_proxy: Option<String>,
}

fn apply_system_proxy_environment() -> Option<String> {
    let detected = detect_system_proxy();
    if let Some(value) = detected.http.as_deref() {
        set_env_if_missing("HTTP_PROXY", value);
        set_env_if_missing("http_proxy", value);
    }
    if let Some(value) = detected.https.as_deref().or(detected.http.as_deref()) {
        set_env_if_missing("HTTPS_PROXY", value);
        set_env_if_missing("https_proxy", value);
    }
    if let Some(value) = detected.no_proxy.as_deref() {
        set_env_if_missing("NO_PROXY", value);
        set_env_if_missing("no_proxy", value);
    }

    let selected = std::env::var("HTTPS_PROXY")
        .ok()
        .or_else(|| std::env::var("https_proxy").ok())
        .or_else(|| std::env::var("ALL_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .or(detected.https)
        .or(detected.http);
    if selected.is_some()
        && std::env::var_os("NO_PROXY").is_none()
        && std::env::var_os("no_proxy").is_none()
    {
        set_env_if_missing("NO_PROXY", "localhost,127.0.0.1,::1");
        set_env_if_missing("no_proxy", "localhost,127.0.0.1,::1");
    }
    selected.map(|value| redact_proxy(&value))
}

fn set_env_if_missing(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

fn detect_system_proxy() -> ProxySettings {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("scutil").arg("--proxy").output() {
            if output.status.success() {
                return parse_scutil_proxy(&String::from_utf8_lossy(&output.stdout));
            }
        }
    }
    #[cfg(windows)]
    {
        let mut reg = Command::new("reg");
        hide_windows_console(&mut reg);
        if let Ok(output) = reg
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ])
            .output()
        {
            if output.status.success() {
                return parse_windows_proxy(&String::from_utf8_lossy(&output.stdout));
            }
        }
    }
    ProxySettings::default()
}

fn parse_scutil_proxy(output: &str) -> ProxySettings {
    let enabled = |key: &str| scutil_value(output, key).as_deref() == Some("1");
    let host = scutil_value(output, "HTTPProxy");
    let http_port = scutil_value(output, "HTTPPort");
    let https_host = scutil_value(output, "HTTPSProxy").or_else(|| host.clone());
    let https_port = scutil_value(output, "HTTPSPort").or_else(|| http_port.clone());
    let http = if enabled("HTTPEnable") {
        proxy_url(host.as_deref(), http_port.as_deref())
    } else {
        None
    };
    let https = if enabled("HTTPSEnable") {
        proxy_url(https_host.as_deref(), https_port.as_deref())
    } else {
        None
    };
    let no_proxy = scutil_exceptions(output);
    ProxySettings {
        http,
        https,
        no_proxy,
    }
}

fn scutil_value(output: &str, key: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (line_key, value) = line.split_once(':')?;
        if line_key.trim() == key {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

fn scutil_exceptions(output: &str) -> Option<String> {
    let values: Vec<String> = output
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            if !key
                .trim()
                .chars()
                .all(|character| character.is_ascii_digit())
            {
                return None;
            }
            let value = value.trim();
            if value.is_empty() || value == "<local>" {
                None
            } else {
                Some(value.replace("*.", "."))
            }
        })
        .collect();
    (!values.is_empty()).then(|| values.join(","))
}

#[cfg(windows)]
fn parse_windows_proxy(output: &str) -> ProxySettings {
    let enabled = output.lines().any(|line| {
        line.to_ascii_lowercase().contains("proxyenable") && line.trim_end().ends_with("0x1")
    });
    if !enabled {
        return ProxySettings::default();
    }
    let server = output.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.contains("proxyserver") {
            line.split_whitespace().last().map(str::to_string)
        } else {
            None
        }
    });
    let mut settings = ProxySettings::default();
    if let Some(server) = server {
        for entry in server.split(';') {
            let (scheme, address) = entry.split_once('=').unwrap_or(("http", entry));
            let value = proxy_url_from_address(address.trim());
            if scheme.eq_ignore_ascii_case("https") {
                settings.https = value;
            } else if scheme.eq_ignore_ascii_case("http") {
                settings.http = value;
            }
        }
    }
    settings.no_proxy = output.lines().find_map(|line| {
        if line.to_ascii_lowercase().contains("proxyoverride") {
            let value = line.split_whitespace().last()?.replace(';', ",");
            Some(value.replace("<local>", "localhost"))
        } else {
            None
        }
    });
    settings
}

fn proxy_url(host: Option<&str>, port: Option<&str>) -> Option<String> {
    let host = host?.trim();
    let port = port?.trim();
    if host.is_empty()
        || port.is_empty()
        || !port.chars().all(|character| character.is_ascii_digit())
    {
        return None;
    }
    Some(format!("http://{}:{}", format_host(host), port))
}

#[cfg(windows)]
fn proxy_url_from_address(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() {
        return None;
    }
    let value = if address.starts_with("http://") || address.starts_with("https://") {
        address.to_string()
    } else {
        format!("http://{address}")
    };
    value.parse::<reqwest::Url>().ok().map(|_| value)
}

fn format_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn redact_proxy(value: &str) -> String {
    let Ok(mut url) = value.parse::<reqwest::Url>() else {
        return "系统代理已启用".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.to_string()
}

fn read_owner_token(config_dir: &Path) -> Option<String> {
    let auth_value: Option<serde_json::Value> = fs::read_to_string(config_dir.join("auth.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    auth_value
        .and_then(|value| value.get("ownerToken")?.as_str().map(str::to_string))
        .or_else(|| {
            fs::read_to_string(config_dir.join("secrets").join("owner-token"))
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

fn configuration_is_ready(config_path: &Path, auth_path: &Path) -> bool {
    let Some(config) = read_stored_config(config_path) else {
        return false;
    };
    let Some(config_dir) = config_path.parent() else {
        return false;
    };
    !config.allowed_roots.is_empty()
        && auth_path.is_file()
        && read_owner_token(config_dir).is_some()
        && read_pilot_token(config_dir).is_some()
}

fn read_stored_config(path: &Path) -> Option<StoredConfig> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn read_pilot_token(config_dir: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_dir.join("auth.json")).ok()?).ok()?;
    value.get("pilotToken")?.as_str().map(str::to_string)
}

fn read_tunnel_token(config_dir: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_dir.join("auth.json")).ok()?).ok()?;
    value.get("tunnelToken")?.as_str().map(str::to_string)
}

fn read_pilot_policy_url(config_dir: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_dir.join("auth.json")).ok()?).ok()?;
    value.get("pilotPolicyUrl")?.as_str().map(str::to_string)
}

fn read_pilot_public_key(config_dir: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_dir.join("auth.json")).ok()?).ok()?;
    value.get("pilotPublicKeyPem")?.as_str().map(str::to_string)
}

fn read_application(path: &Path) -> Option<StoredApplication> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn clear_application_record(config_dir: &Path) -> Result<(), String> {
    match fs::remove_file(config_dir.join("application.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法完成邀请切换：{error}")),
    }
}

fn access_status(response: ApplicationApiStatus) -> AccessStatus {
    AccessStatus {
        status: response.status,
        application_id: Some(response.application_id),
        created_at: response.created_at,
        period: response.period,
        expires_at: response.expires_at,
        mcp_url: response.mcp_url,
        reason: response.reason,
    }
}

async fn control_request<T: serde::de::DeserializeOwned>(
    method: reqwest::Method,
    url: &str,
    bearer_token: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<T, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "[CONTROL_CONNECT] 暂时无法准备网络连接，请稍后再试".to_string())?;
    let mut request = client
        .request(method, url)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    if let Some(value) = body {
        request = request.json(&value);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "[CONTROL_TIMEOUT] 联系搭手服务超时，请检查网络后重试".to_string()
        } else {
            "[CONTROL_CONNECT] 暂时无法联系搭手服务，请检查网络后重试".to_string()
        }
    })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|_| "[CONTROL_RESPONSE_INVALID] 搭手服务返回了无法读取的结果".to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<ApiError>(&text)
            .ok()
            .and_then(|value| value.error)
            .unwrap_or_else(|| "申请暂时没有完成".into());
        return Err(format!(
            "[CONTROL_HTTP_{}] 搭手服务返回 {}：{}",
            status.as_u16(),
            status.as_u16(),
            message
        ));
    }
    serde_json::from_str(&text)
        .map_err(|_| "[CONTROL_RESPONSE_INVALID] 搭手服务返回了无法识别的结果".to_string())
}

fn validate_diagnostic_event(
    stage: &str,
    outcome: &str,
    error_code: Option<&str>,
    application_id: Option<&str>,
) -> Result<(), String> {
    if !DIAGNOSTIC_STAGES.contains(&stage) {
        return Err("不支持的诊断阶段".into());
    }
    if !matches!(outcome, "ok" | "error") {
        return Err("不支持的诊断结果".into());
    }
    if let Some(code) = error_code {
        if code.len() > 48
            || code.len() < 3
            || !code
                .chars()
                .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == '_')
        {
            return Err("不支持的诊断错误代码".into());
        }
    }
    if let Some(id) = application_id {
        if id.len() > 68
            || !id.starts_with("req_")
            || !id
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
        {
            return Err("不支持的申请编号".into());
        }
    }
    Ok(())
}

fn append_diagnostic_event(data_dir: &Path, event: DiagnosticEvent) -> Result<(), String> {
    let logs_dir = data_dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| error.to_string())?;
    let path = logs_dir.join("desktop-events.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    serde_json::to_writer(&mut file, &event).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())
}

fn build_diagnostic_report(data_dir: &Path) -> DiagnosticReport {
    let path = data_dir.join("logs").join("desktop-events.jsonl");
    let events = fs::read_to_string(path)
        .ok()
        .map(|text| {
            let mut events = text
                .lines()
                .filter_map(|line| serde_json::from_str::<DiagnosticEvent>(line).ok())
                .collect::<Vec<_>>();
            if events.len() > 20 {
                events.drain(..events.len() - 20);
            }
            events
        })
        .unwrap_or_default();
    DiagnosticReport {
        product: "Dashou Desktop",
        app_version: env!("CARGO_PKG_VERSION").into(),
        platform: platform_name(),
        events,
        privacy: "仅含状态、时间、版本、平台和错误类别；不含密码、Token、目录路径、文件内容或 ChatGPT 对话。",
    }
}

async fn sync_diagnostic_events(data_dir: &Path, application: &StoredApplication) -> Result<(), String> {
    let Some(application_id) = application.application_id.as_deref() else {
        return Ok(());
    };
    let path = data_dir.join("logs").join("desktop-events.jsonl");
    let mut events = fs::read_to_string(path)
        .ok()
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<DiagnosticEvent>(line).ok())
                .filter(|event| !event.event_id.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if events.is_empty() {
        return Ok(());
    }
    if events.len() > 50 {
        events.drain(..events.len() - 50);
    }
    let base_url = normalize_control_base_url(&application.control_base_url)?;
    let body = serde_json::json!({
        "events": events.into_iter().map(|event| serde_json::json!({
            "eventId": event.event_id,
            "stage": event.stage,
            "outcome": event.outcome,
            "errorCode": event.error_code,
            "appVersion": event.app_version,
            "unixSeconds": event.unix_seconds,
        })).collect::<Vec<_>>(),
    });
    let _: serde_json::Value = control_request(
        reqwest::Method::POST,
        &format!("{base_url}/applications/{application_id}/events"),
        Some(&application.application_token),
        Some(body),
    )
    .await?;
    Ok(())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn save_activation(config_dir: &Path, activation: &ActivationResponse) -> Result<(), String> {
    let public_base_url = normalize_public_url(&activation.public_base_url)?;
    let expected_mcp_url = format!("{}/mcp", public_base_url.trim_end_matches('/'));
    if activation.mcp_url.trim_end_matches('/') != expected_mcp_url {
        return Err("搭手服务返回的连接地址不一致，请联系管理员".into());
    }
    let pilot_policy_url = normalize_control_url(&activation.pilot_policy_url)?;
    if activation.tunnel_token.trim().len() < 16 || activation.pilot_token.trim().len() < 16 {
        return Err("搭手服务返回的设备授权不完整，请联系管理员".into());
    }
    let pilot_public_key = activation.pilot_public_key_pem.trim();
    if !pilot_public_key.starts_with("-----BEGIN PUBLIC KEY-----")
        || !pilot_public_key.ends_with("-----END PUBLIC KEY-----")
    {
        return Err("搭手服务返回的签名信息无效，请联系管理员".into());
    }
    fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    let existing_config = read_stored_config(&config_dir.join("config.json"));
    let owner_token = read_owner_token(config_dir).unwrap_or_else(generate_token);
    write_json_atomic(
        &config_dir.join("config.json"),
        &StoredConfig {
            host: "127.0.0.1".into(),
            port: existing_config
                .as_ref()
                .map(|config| config.port)
                .unwrap_or(7677),
            allowed_roots: existing_config
                .map(|config| config.allowed_roots)
                .unwrap_or_default(),
            public_base_url,
        },
        false,
    )?;
    write_json_atomic(
        &config_dir.join("auth.json"),
        &StoredAuth {
            owner_token,
            pilot_token: activation.pilot_token.trim().into(),
            tunnel_token: Some(activation.tunnel_token.trim().into()),
            pilot_policy_url: Some(pilot_policy_url),
            pilot_public_key_pem: Some(pilot_public_key.into()),
        },
        true,
    )
}

fn control_base_url() -> String {
    std::env::var("DASHOU_CONTROL_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| CONTROL_BASE_URL.into())
}

fn normalize_control_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    normalize_control_url(value)?;
    Ok(value.to_string())
}

fn normalize_control_url(value: &str) -> Result<String, String> {
    let url = value
        .parse::<reqwest::Url>()
        .map_err(|_| "搭手服务地址无效".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("搭手服务地址必须使用安全连接".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return name.chars().take(100).collect();
            }
        }
    }
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim();
            if !name.is_empty() {
                return name.chars().take(100).collect();
            }
        }
    }
    "我的电脑".into()
}

fn platform_name() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn locate_resource_root(resource_dir: &Path) -> PathBuf {
    let candidates = [
        resource_dir.to_path_buf(),
        resource_dir.join("_up_").join("vendor"),
        resource_dir.join("vendor"),
    ];
    candidates
        .into_iter()
        .find(|candidate| {
            candidate.join("node-runtime").join(node_name()).is_file()
                && candidate
                    .join("dashou-runtime")
                    .join("dist")
                    .join("dashou-cli.js")
                    .is_file()
                && candidate
                    .join("cloudflared")
                    .join(cloudflared_name())
                    .is_file()
        })
        .unwrap_or_else(|| resource_dir.to_path_buf())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T, secret: bool) -> Result<(), String> {
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let text = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temp, [text.as_slice(), b"\n"].concat()).map_err(|error| error.to_string())?;
    if secret {
        set_private_file(&temp)?;
    }
    fs::rename(temp, path).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn normalize_public_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if !(value.starts_with("https://")
        || value.starts_with("http://localhost")
        || value.starts_with("http://127.0.0.1"))
    {
        return Err("公网地址必须是 HTTPS（本机测试可使用 localhost）".into());
    }
    if value.len() < 13 {
        return Err("公网地址无效".into());
    }
    Ok(value.to_string())
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn cloudflared_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DaemonState(Mutex::new(None)))
        .setup(|app| {
            let show_item = MenuItemBuilder::with_id("show", "显示搭手").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出搭手").build(app)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("搭手 Dashou")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon).icon_as_template(true);
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            connection_code,
            apply_for_access,
            application_status,
            record_client_event,
            diagnostic_report,
            configuration,
            import_invite,
            configure,
            start_daemon,
            stop_daemon,
            take_over_daemon
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window is intentionally a hide action. The
                // local MCP service remains available from the menu-bar tray
                // until the user explicitly chooses "退出搭手".
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Dashou desktop application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<DaemonState>() {
                    let _ = stop_child(&state);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_resource_tree(root: &Path) {
        for (directory, file) in [
            ("node-runtime", node_name()),
            ("dashou-runtime/dist", "dashou-cli.js"),
            ("cloudflared", cloudflared_name()),
        ] {
            let directory = root.join(directory);
            fs::create_dir_all(&directory).expect("create resource test directory");
            fs::write(directory.join(file), b"test").expect("create resource test file");
        }
    }

    #[test]
    fn locates_flat_resource_root() {
        let root = test_root("flat");
        make_resource_tree(&root);
        assert_eq!(locate_resource_root(&root), root);
        fs::remove_dir_all(root).expect("remove resource test directory");
    }

    #[test]
    fn locates_tauri_up_vendor_resource_root() {
        let root = test_root("up");
        let vendor = root.join("_up_").join("vendor");
        make_resource_tree(&vendor);
        assert_eq!(locate_resource_root(&root), vendor);
        fs::remove_dir_all(root).expect("remove resource test directory");
    }

    #[test]
    fn parses_macos_system_proxy_and_exceptions() {
        let output = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : *.warmbyte.studio\n    2 : <local>\n  }\n  HTTPEnable : 1\n  HTTPPort : 1082\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 1082\n  HTTPSProxy : 127.0.0.1\n}";
        let settings = parse_scutil_proxy(output);
        assert_eq!(settings.http.as_deref(), Some("http://127.0.0.1:1082"));
        assert_eq!(settings.https.as_deref(), Some("http://127.0.0.1:1082"));
        assert_eq!(
            settings.no_proxy.as_deref(),
            Some("127.0.0.1,.warmbyte.studio")
        );
    }

    #[test]
    fn desktop_status_does_not_serialize_connection_secret() {
        let status = DesktopStatus {
            configured: true,
            running: true,
            version: "0.1.3-rc.3".into(),
            mcp_url: Some("https://pilot.warmbyte.studio/mcp".into()),
            local_health: true,
            public_health: true,
            proxy: None,
            error: None,
        };
        let json = serde_json::to_value(status).expect("serialize status");
        assert!(json.get("connectionCode").is_none());
        assert!(json.get("ownerToken").is_none());
    }

    #[test]
    fn diagnostic_report_contains_only_allowlisted_event_fields() {
        let root = test_root("diagnostics");
        append_diagnostic_event(
            &root,
            DiagnosticEvent {
                event_id: "evt_abcdefghijklmnop".into(),
                unix_seconds: 1_786_838_400,
                stage: "application_submit_failed".into(),
                outcome: "error".into(),
                app_version: "0.1.3-rc.3".into(),
                error_code: Some("CONTROL_CONNECT".into()),
                application_id: None,
            },
        )
        .expect("write diagnostic event");
        let report = build_diagnostic_report(&root);
        let json = serde_json::to_string(&report).expect("serialize diagnostic report");
        assert!(json.contains("CONTROL_CONNECT"));
        assert!(!json.contains("token"));
        assert!(!json.contains("/Users/"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("logs").join("desktop-events.jsonl"))
                    .expect("diagnostic metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).expect("remove diagnostic test directory");
    }

    #[test]
    fn diagnostic_events_reject_free_form_sensitive_values() {
        assert!(validate_diagnostic_event(
            "application_submit_failed",
            "error",
            Some("CONTROL_TIMEOUT"),
            Some("req_abcdefghijklmnop")
        )
        .is_ok());
        assert!(validate_diagnostic_event("custom_path", "ok", None, None).is_err());
        assert!(validate_diagnostic_event(
            "application_submit_failed",
            "error",
            Some("password=secret"),
            None
        )
        .is_err());
    }

    #[test]
    fn activation_is_saved_privately_without_replacing_selected_folders() {
        let root = test_root("activation");
        fs::create_dir_all(&root).expect("create activation test directory");
        write_json_atomic(
            &root.join("config.json"),
            &StoredConfig {
                host: "127.0.0.1".into(),
                port: 7677,
                allowed_roots: vec!["/tmp/project-one".into(), "/tmp/project-two".into()],
                public_base_url: "https://old.example".into(),
            },
            false,
        )
        .expect("write initial config");
        let activation = ActivationResponse {
            public_base_url: "https://device-test.warmbyte.studio".into(),
            mcp_url: "https://device-test.warmbyte.studio/mcp".into(),
            tunnel_token: "test-tunnel-token-123456789".into(),
            pilot_token: "test-pilot-token-123456789".into(),
            pilot_policy_url: "https://control.example/pilot-policy".into(),
            pilot_public_key_pem:
                "-----BEGIN PUBLIC KEY-----\ntest-public-key\n-----END PUBLIC KEY-----".into(),
            activation_receipt: "receipt-is-not-persisted".into(),
        };
        save_activation(&root, &activation).expect("save activation");
        let config = read_stored_config(&root.join("config.json")).expect("read saved config");
        assert_eq!(config.allowed_roots.len(), 2);
        assert_eq!(
            config.public_base_url,
            "https://device-test.warmbyte.studio"
        );
        let auth = fs::read_to_string(root.join("auth.json")).expect("read saved auth");
        assert!(auth.contains("test-tunnel-token-123456789"));
        assert!(auth.contains("test-pilot-token-123456789"));
        assert!(!auth.contains("receipt-is-not-persisted"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("auth.json"))
                    .expect("auth metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).expect("remove activation test directory");
    }

    #[test]
    fn fallback_invite_clears_stale_application_record() {
        let root = test_root("fallback-invite");
        fs::create_dir_all(&root).expect("create fallback invite test directory");
        fs::write(root.join("application.json"), b"stale application")
            .expect("write stale application record");

        clear_application_record(&root).expect("clear stale application record");
        assert!(!root.join("application.json").exists());
        clear_application_record(&root).expect("missing application record is already clear");

        fs::remove_dir_all(root).expect("remove fallback invite test directory");
    }

    #[test]
    fn recognizes_only_dashou_serve_commands() {
        assert!(is_dashou_serve_command(
            "node /Applications/Dashou.app/Contents/Resources/vendor/dashou-runtime/dist/dashou-cli.js serve"
        ));
        assert!(is_dashou_serve_command(
            "\"C:\\\\Dashou\\\\node.exe\" --use-env-proxy \"C:\\\\Dashou\\\\dist\\\\dashou-cli.js\" serve"
        ));
        assert!(!is_dashou_serve_command("node /tmp/other.js serve"));
        assert!(!is_dashou_serve_command("node /tmp/dashou-cli.js doctor"));
        assert!(!is_dashou_serve_command(
            "/usr/bin/python /tmp/dashou-cli.js serve"
        ));
    }

    #[test]
    fn tasklist_pid_parser_does_not_treat_empty_results_as_live_processes() {
        let matching = br#""node.exe","4242","Console","1","42,000 K""#;
        assert!(tasklist_contains_pid(matching, 4242));
        assert!(!tasklist_contains_pid(matching, 4243));
        assert!(!tasklist_contains_pid(b"INFO: No tasks are running which match the specified criteria.", 4242));
    }

    #[cfg(windows)]
    #[test]
    fn parses_windows_system_proxy() {
        let output = "    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=127.0.0.1:1082;https=127.0.0.1:1083\n    ProxyOverride  REG_SZ    <local>;*.warmbyte.studio\n";
        let settings = parse_windows_proxy(output);
        assert_eq!(settings.http.as_deref(), Some("http://127.0.0.1:1082"));
        assert_eq!(settings.https.as_deref(), Some("http://127.0.0.1:1083"));
        assert_eq!(
            settings.no_proxy.as_deref(),
            Some("localhost,*.warmbyte.studio")
        );
    }

    fn test_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "dashou-resource-{label}-{}-{nanos}",
            std::process::id()
        ))
    }
}
