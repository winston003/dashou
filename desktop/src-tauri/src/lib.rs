use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
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
    connection_code: Option<String>,
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
fn status(app: AppHandle, state: State<'_, DaemonState>) -> Result<DesktopStatus, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let config_path = data_dir.join("config").join("config.json");
    let configured = config_path.exists();
    let running = daemon_is_running(&state);
    let mcp_url = if configured {
        read_public_url(&config_path).map(|url| format!("{}/mcp", url.trim_end_matches('/')))
    } else {
        None
    };
    Ok(DesktopStatus {
        configured,
        running,
        version: env!("CARGO_PKG_VERSION").to_string(),
        mcp_url,
        connection_code: read_owner_token(config_path.parent().unwrap_or(Path::new(""))),
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
    let mut command = Command::new(node);
    command
        // The bundled Node 22 runtime supports this flag and must honor the
        // user's HTTPS_PROXY/NO_PROXY settings on networks that require one.
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
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
    *guard = Some(
        command
            .spawn()
            .map_err(|error| format!("无法启动搭手服务：{error}"))?,
    );
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
