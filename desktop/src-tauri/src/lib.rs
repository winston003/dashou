use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, State};

struct DaemonState(Mutex<Option<Child>>);

const PILOT_POLICY_URL: &str = "https://dashou-pilot-control.whilewon.workers.dev/pilot-policy";
const PILOT_POLICY_PUBLIC_KEY: &str = r#"-----BEGIN PUBLIC KEY-----
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
}

#[tauri::command]
async fn status(app: AppHandle, state: State<'_, DaemonState>) -> Result<DesktopStatus, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_path = data_dir.join("config").join("config.json");
    let configured = config_path.exists();
    let running = daemon_is_running(&state);
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
    if settings.pilot_token.trim().is_empty() {
        return Err("内测连接码不能为空".into());
    }
    let public_url = normalize_public_url(&settings.public_base_url)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = data_dir.join("config");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let owner_token = read_owner_token(&config_dir).unwrap_or_else(generate_token);
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
            pilot_token: settings.pilot_token,
            tunnel_token: settings
                .tunnel_token
                .filter(|token| !token.trim().is_empty()),
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
        .env("DASHOU_PILOT_POLICY_URL", PILOT_POLICY_URL)
        .env("DASHOU_PILOT_POLICY_PUBLIC_KEY", PILOT_POLICY_PUBLIC_KEY)
        .env("DASHOU_PILOT_POLICY_TOKEN", pilot_token)
        .env("DASHOU_CLOUDFLARED_PATH", cloudflared)
        .env("DASHOU_EMBEDDED_RUNTIME", "1")
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file_for_stdout))
        .stderr(Stdio::from(log_file));
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000 | 0x00000200);
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
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.wait();
    }
    Ok(())
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
        if let Ok(output) = Command::new("reg")
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
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_dir.join("auth.json")).ok()?).ok()?;
    value.get("ownerToken")?.as_str().map(str::to_string)
}

fn read_pilot_token(config_dir: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_dir.join("auth.json")).ok()?).ok()?;
    value.get("pilotToken")?.as_str().map(str::to_string)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DaemonState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            status,
            connection_code,
            configure,
            start_daemon,
            stop_daemon
        ])
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
    use std::time::{SystemTime, UNIX_EPOCH};

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
            version: "0.1.2-rc7".into(),
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
