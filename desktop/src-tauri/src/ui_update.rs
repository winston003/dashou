use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

const UI_MANIFEST_URL: &str =
    "https://github.com/winston003/dashou-releases/releases/download/ui-current/ui-latest.json";
const COPY_MANIFEST_URL: &str =
    "https://github.com/winston003/dashou-releases/releases/download/copy-current/copy-latest.json";
const UI_PUBLIC_KEY: &str = env!("DASHOU_UI_PUBLIC_KEY");
pub const BRIDGE_VERSION: u32 = 2;
const MAX_MANIFEST_BYTES: usize = 32 * 1024;
const MAX_UI_ARCHIVE_BYTES: usize = 5 * 1024 * 1024;
const MAX_UI_EXPANDED_BYTES: u64 = 12 * 1024 * 1024;
const MAX_UI_FILES: usize = 160;
const MAX_COPY_BYTES: usize = 24 * 1024;

const COPY_KEYS: &[&str] = &[
    "loading",
    "brandTagline",
    "footerTrust",
    "mainNavigation",
    "setupTitle",
    "setupIntro",
    "startSetup",
    "submitting",
    "trialIdle",
    "trialPendingTitle",
    "trialPendingBody",
    "trialProvisioningTitle",
    "trialProvisioningBody",
    "trialSlow",
    "progressReceived",
    "progressPreparing",
    "progressChecking",
    "progressReady",
    "readyTitle",
    "readyBody",
    "trustTitle",
    "trustBody",
    "failureTitle",
    "failureBody",
    "chooseFolders",
    "chooseFoldersHint",
    "folderPickerTitle",
    "folderListLabel",
    "keepOneFolder",
    "addFolder",
    "removeFolder",
    "noFolders",
    "startUsing",
    "retry",
    "copyDiagnostics",
    "preparing",
    "connecting",
    "ready",
    "recovering",
    "blocked",
    "stopped",
    "openChatGPT",
    "copyPassword",
    "passwordCopied",
    "copyAddress",
    "addressCopied",
    "residentNote",
    "settings",
    "settingsIntro",
    "currentVersion",
    "use",
    "helpTitle",
    "helpBody",
    "helpPath",
    "autostart",
    "autostartHint",
    "notifications",
    "notificationsHint",
    "checkUpdate",
    "checkingUpdate",
    "updateReady",
    "alreadyLatest",
    "advanced",
    "importInvite",
    "configureAgain",
    "workspaceEyebrow",
    "connectedEyebrow",
    "readyHint",
    "recoveringHint",
    "workingHint",
    "savingFolders",
    "foldersSaved",
    "reconnecting",
    "chatgptOpened",
    "diagnosticsFailure",
    "statusReady",
    "applicationReceived",
    "diagnosticsCopied",
    "troubleshootingTitle",
    "troubleshootingHint",
    "currentStatus",
    "currentStep",
    "deviceLabel",
    "recentCheck",
    "applicationLabel",
    "applicationNotStarted",
    "applicationWaiting",
    "applicationPreparing",
    "applicationReady",
    "applicationRejected",
    "applicationEnded",
    "stepNotApplied",
    "stepWaitingConfirmation",
    "stepPreparingConnection",
    "stepStartingLocalService",
    "stepRecoveringConnection",
    "stepReady",
    "stepRuntimeBlocked",
    "stepOtherConnection",
    "stepNeedsAttention",
    "updateUnavailable",
    "autostartFailure",
    "notificationUnavailable",
    "settingsSaveFailure",
    "inviteImported",
    "inviteImportFailure",
    "passwordNotReady",
    "chatgptFailure",
    "addressFailure",
    "folderPickerFailure",
    "foldersSaveFailure",
    "errorOtherProcess",
    "errorControlTimeout",
    "errorControlConnect",
    "errorControlResponse",
    "errorRuntimeStart",
    "errorNotConfigured",
    "errorMissingResources",
    "errorNoRoots",
    "errorInvalidRoot",
    "errorDuplicateRoot",
    "errorInvite",
    "notificationTitle",
    "notificationBody",
    "uiFailureTitle",
    "uiFailureBody",
    "reloadUi",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    schema_version: u32,
    version: String,
    min_shell_version: String,
    #[serde(default)]
    bridge_version: Option<u32>,
    url: String,
    sha256: String,
    signature: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiState {
    active: Option<String>,
    previous: Option<String>,
    pending: Option<String>,
    #[serde(default)]
    last_good: Option<String>,
    #[serde(default)]
    failed: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiBundleStatus {
    pub source: &'static str,
    pub version: Option<String>,
    pub update_available: bool,
    pub changed: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyBundle {
    schema_version: u32,
    version: String,
    messages: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyBundleStatus {
    version: Option<String>,
    messages: BTreeMap<String, String>,
    changed: bool,
}

pub fn recover_interrupted_update(app: &AppHandle) -> Result<Option<String>, String> {
    let root = ui_root(app)?;
    Ok(recover_interrupted_state(&root)?.active)
}

fn recover_interrupted_state(root: &Path) -> Result<UiState, String> {
    let mut state = read_state(root);
    if let Some(failed) = state.pending.take() {
        if state.active.as_deref() == Some(&failed) {
            state.active = state.previous.take();
        }
        if !state.failed.contains(&failed) {
            state.failed.push(failed);
        }
        write_state(root, &state)?;
    }
    Ok(state)
}

pub fn navigate_to_active(app: &AppHandle, version: &str) -> Result<(), String> {
    validate_release_version(version)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到搭手主窗口".to_string())?;
    let url =
        tauri::Url::parse("dashou-ui://localhost/index.html").map_err(|error| error.to_string())?;
    window.navigate(url).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ui_bundle_status(app: AppHandle) -> Result<UiBundleStatus, String> {
    let state = read_state(&ui_root(&app)?);
    Ok(UiBundleStatus {
        source: if state.active.is_some() {
            "downloaded"
        } else {
            "built-in"
        },
        version: state.active,
        update_available: false,
        changed: false,
    })
}

#[tauri::command]
pub fn ui_ready(app: AppHandle, version: String) -> Result<(), String> {
    validate_release_version(&version)?;
    let root = ui_root(&app)?;
    let mut state = read_state(&root);
    if state.active.as_deref() != Some(&version) {
        return Err("当前界面版本与已启用版本不一致".into());
    }
    state.pending = None;
    state.last_good = Some(version);
    write_state(&root, &state)
}

#[tauri::command]
pub async fn check_ui_update(app: AppHandle) -> Result<UiBundleStatus, String> {
    let manifest = fetch_manifest(UI_MANIFEST_URL, true).await?;
    let root = ui_root(&app)?;
    let current = read_state(&root);
    if current.failed.contains(&manifest.version)
        || current
            .active
            .as_ref()
            .is_some_and(|version| version_cmp(&manifest.version, version) != Ordering::Greater)
    {
        return Ok(UiBundleStatus {
            source: "downloaded",
            version: current.active,
            update_available: false,
            changed: false,
        });
    }
    let bytes = fetch_bytes(&manifest.url, MAX_UI_ARCHIVE_BYTES).await?;
    verify_artifact(&manifest, &bytes)?;
    install_ui_archive(&root, &manifest.version, &bytes)?;
    let mut next = current;
    next.previous = next.active.take();
    next.active = Some(manifest.version.clone());
    next.pending = Some(manifest.version.clone());
    write_state(&root, &next)?;
    cleanup_versions(&root, &next)?;
    navigate_to_active(&app, &manifest.version)?;
    Ok(UiBundleStatus {
        source: "downloaded",
        version: Some(manifest.version),
        update_available: true,
        changed: true,
    })
}

#[tauri::command]
pub fn copy_bundle(app: AppHandle) -> Result<CopyBundleStatus, String> {
    let bundle = read_latest_copy_bundle(&copy_root(&app)?);
    Ok(CopyBundleStatus {
        version: bundle.as_ref().map(|value| value.version.clone()),
        messages: bundle.map(|value| value.messages).unwrap_or_default(),
        changed: false,
    })
}

#[tauri::command]
pub async fn check_copy_update(app: AppHandle) -> Result<CopyBundleStatus, String> {
    let manifest = fetch_manifest(COPY_MANIFEST_URL, false).await?;
    let root = copy_root(&app)?;
    let current = read_latest_copy_bundle(&root);
    if current
        .as_ref()
        .is_some_and(|value| version_cmp(&manifest.version, &value.version) != Ordering::Greater)
    {
        let bundle = current.unwrap_or_else(|| CopyBundle {
            schema_version: 1,
            version: manifest.version,
            messages: BTreeMap::new(),
        });
        return Ok(CopyBundleStatus {
            version: Some(bundle.version),
            messages: bundle.messages,
            changed: false,
        });
    }
    let bytes = fetch_bytes(&manifest.url, MAX_COPY_BYTES).await?;
    verify_artifact(&manifest, &bytes)?;
    let bundle: CopyBundle =
        serde_json::from_slice(&bytes).map_err(|error| format!("文案更新格式不正确：{error}"))?;
    validate_copy_bundle(&bundle, &manifest.version)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(format!("{}.json", manifest.version));
    if !path.exists() {
        write_new_file(&path, &bytes)?;
    }
    Ok(CopyBundleStatus {
        version: Some(bundle.version),
        messages: bundle.messages,
        changed: true,
    })
}

pub fn protocol_response(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match protocol_asset(app, request.uri().path()) {
        Ok((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .header(
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            )
            .header("X-Content-Type-Options", "nosniff")
            .body(bytes)
            .unwrap(),
        Err((status, message)) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header("X-Content-Type-Options", "nosniff")
            .body(message.into_bytes())
            .unwrap(),
    }
}

fn protocol_asset(
    app: &AppHandle,
    uri_path: &str,
) -> Result<(Vec<u8>, &'static str), (StatusCode, String)> {
    let root = ui_root(app).map_err(internal_error)?;
    let state = read_state(&root);
    let version = state
        .active
        .ok_or_else(|| (StatusCode::NOT_FOUND, "没有已启用的界面包".into()))?;
    validate_release_version(&version)
        .map_err(|_| (StatusCode::BAD_REQUEST, "界面版本无效".into()))?;
    let relative = safe_request_path(uri_path)?;
    let version_root = root.join("versions").join(&version);
    let canonical_root = version_root.canonicalize().map_err(internal_error)?;
    let candidate = version_root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| (StatusCode::NOT_FOUND, "文件不存在".into()))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err((StatusCode::FORBIDDEN, "不允许访问该文件".into()));
    }
    let mime = mime_for(&canonical).ok_or_else(|| {
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "不支持该文件类型".into(),
        )
    })?;
    let bytes = fs::read(canonical).map_err(internal_error)?;
    Ok((bytes, mime))
}

async fn fetch_manifest(url: &str, require_bridge: bool) -> Result<ArtifactManifest, String> {
    let bytes = fetch_bytes(url, MAX_MANIFEST_BYTES).await?;
    let manifest: ArtifactManifest =
        serde_json::from_slice(&bytes).map_err(|error| format!("更新清单格式不正确：{error}"))?;
    validate_manifest(&manifest, require_bridge)?;
    Ok(manifest)
}

async fn fetch_bytes(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    validate_download_url(url)?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header("Cache-Control", "no-cache")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("无法获取更新：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("更新服务返回 HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("更新文件超过允许大小".into());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("更新文件超过允许大小".into());
    }
    Ok(bytes.to_vec())
}

fn validate_manifest(manifest: &ArtifactManifest, require_bridge: bool) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("不支持该更新清单版本".into());
    }
    validate_release_version(&manifest.version)?;
    let minimum = Version::parse(&manifest.min_shell_version)
        .map_err(|_| "更新清单中的最低外壳版本无效".to_string())?;
    let shell = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
    if shell < minimum {
        return Err("这个界面需要先更新搭手应用".into());
    }
    if require_bridge && manifest.bridge_version != Some(BRIDGE_VERSION) {
        return Err("这个界面与当前搭手应用不兼容".into());
    }
    if manifest.sha256.len() != 64 || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("更新清单缺少有效的完整性校验".into());
    }
    if manifest.signature.len() < 80 || manifest.signature.len() > 4096 {
        return Err("更新清单缺少有效签名".into());
    }
    validate_download_url(&manifest.url)
}

fn validate_download_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "更新地址无效".to_string())?;
    if url.scheme() != "https" {
        return Err("更新必须使用 HTTPS".into());
    }
    let host = url.host_str().unwrap_or_default();
    if host != "github.com" && host != "objects.githubusercontent.com" {
        return Err("更新地址不在允许的发布站点".into());
    }
    Ok(())
}

fn verify_artifact(manifest: &ArtifactManifest, bytes: &[u8]) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(&manifest.sha256) {
        return Err("更新文件完整性校验失败".into());
    }
    verify_signature_with_key(bytes, &manifest.signature, UI_PUBLIC_KEY)
}

fn verify_signature_with_key(
    bytes: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(), String> {
    let public_text = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(public_key_base64)
            .map_err(|_| "内置更新公钥无效".to_string())?,
    )
    .map_err(|_| "内置更新公钥无效".to_string())?;
    let signature_text = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(signature_base64)
            .map_err(|_| "更新签名编码无效".to_string())?,
    )
    .map_err(|_| "更新签名编码无效".to_string())?;
    let public_key =
        PublicKey::decode(&public_text).map_err(|error| format!("更新公钥无效：{error}"))?;
    let signature =
        Signature::decode(&signature_text).map_err(|error| format!("更新签名无效：{error}"))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|_| "更新签名校验失败".to_string())
}

fn install_ui_archive(root: &Path, version: &str, bytes: &[u8]) -> Result<(), String> {
    validate_release_version(version)?;
    fs::create_dir_all(root.join("versions")).map_err(|error| error.to_string())?;
    let temp = root
        .join("versions")
        .join(format!(".{version}.tmp-{}", unix_millis()));
    fs::create_dir(&temp).map_err(|error| error.to_string())?;
    let result = extract_zip(&temp, bytes);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temp);
        return Err(error);
    }
    if !temp.join("index.html").is_file() {
        let _ = fs::remove_dir_all(&temp);
        return Err("界面包缺少入口文件".into());
    }
    let destination = root.join("versions").join(version);
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, &destination).map_err(|error| error.to_string())
}

fn extract_zip(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("无法打开界面包：{error}"))?;
    if archive.is_empty() || archive.len() > MAX_UI_FILES {
        return Err("界面包文件数量不符合要求".into());
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(relative) = entry.enclosed_name().map(Path::to_path_buf) else {
            return Err("界面包包含不安全路径".into());
        };
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("界面包包含不安全路径".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("界面包不能包含链接文件".into());
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_UI_EXPANDED_BYTES {
            return Err("界面包展开后超过允许大小".into());
        }
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if mime_for(&output).is_none() {
            return Err(format!("界面包包含不支持的文件：{}", relative.display()));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = fs::File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_copy_bundle(bundle: &CopyBundle, expected_version: &str) -> Result<(), String> {
    if bundle.schema_version != 1 || bundle.version != expected_version {
        return Err("文案更新版本不一致".into());
    }
    let allowed: HashSet<&str> = COPY_KEYS.iter().copied().collect();
    if bundle.messages.len() > COPY_KEYS.len() {
        return Err("文案更新包含过多内容".into());
    }
    for (key, value) in &bundle.messages {
        if !allowed.contains(key.as_str()) || value.trim().is_empty() || value.chars().count() > 280
        {
            return Err(format!("文案更新字段不符合要求：{key}"));
        }
    }
    Ok(())
}

fn safe_request_path(uri_path: &str) -> Result<PathBuf, (StatusCode, String)> {
    let path = uri_path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if path.contains('%') || path.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "路径无效".into()));
    }
    let candidate = Path::new(path);
    if candidate
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err((StatusCode::BAD_REQUEST, "路径无效".into()));
    }
    Ok(candidate.to_path_buf())
}

fn validate_release_version(version: &str) -> Result<(), String> {
    if version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("界面版本无效".into());
    }
    Ok(())
}

fn mime_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "html" => Some("text/html; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

fn ui_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("ui"))
}

fn copy_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("copy"))
}

fn read_state(root: &Path) -> UiState {
    let Ok(text) = fs::read_to_string(root.join("state.log")) else {
        return UiState::default();
    };
    text.lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .unwrap_or_default()
}

fn read_copy_bundle(path: &Path) -> Option<CopyBundle> {
    let bytes = fs::read(path).ok()?;
    let bundle: CopyBundle = serde_json::from_slice(&bytes).ok()?;
    validate_copy_bundle(&bundle, &bundle.version).ok()?;
    Some(bundle)
}

fn read_latest_copy_bundle(root: &Path) -> Option<CopyBundle> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| read_copy_bundle(&entry.path()))
        .max_by(|left, right| version_cmp(&left.version, &right.version))
}

fn write_state(root: &Path, state: &UiState) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    // Start and end every journal entry with a newline. If the process dies
    // halfway through one append, the next complete entry cannot be joined to
    // the torn JSON and remains independently recoverable.
    let mut bytes = vec![b'\n'];
    bytes.extend(serde_json::to_vec(state).map_err(|error| error.to_string())?);
    bytes.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("state.log"))
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "更新目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".write-{}.tmp", unix_millis()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    if path.exists() {
        let _ = fs::remove_file(&temp);
        return Ok(());
    }
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn version_cmp(left: &str, right: &str) -> Ordering {
    let parse = |value: &str| {
        value
            .split(['.', '-', '_'])
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
    };
    match (parse(left), parse(right)) {
        (Ok(mut left), Ok(mut right)) => {
            let length = left.len().max(right.len());
            left.resize(length, 0);
            right.resize(length, 0);
            left.cmp(&right)
        }
        _ => left.cmp(right),
    }
}

fn cleanup_versions(root: &Path, state: &UiState) -> Result<(), String> {
    let keep: HashSet<&str> = [
        state.active.as_deref(),
        state.previous.as_deref(),
        state.last_good.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect();
    let versions = root.join("versions");
    let Ok(entries) = fs::read_dir(versions) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && !keep.contains(name.as_str()) && !name.starts_with('.') {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn request_paths_reject_traversal_and_encoding() {
        assert_eq!(safe_request_path("/").unwrap(), PathBuf::from("index.html"));
        assert!(safe_request_path("/../secret").is_err());
        assert!(safe_request_path("/%2e%2e/secret").is_err());
        assert!(safe_request_path("/assets\\secret.js").is_err());
    }

    #[test]
    fn copy_bundle_accepts_only_known_short_messages() {
        let mut messages = BTreeMap::new();
        messages.insert("setupTitle".into(), "让这台电脑用上搭手".into());
        let bundle = CopyBundle {
            schema_version: 1,
            version: "2026.08.17.1".into(),
            messages,
        };
        assert!(validate_copy_bundle(&bundle, "2026.08.17.1").is_ok());
        let mut invalid = bundle.clone();
        invalid
            .messages
            .insert("dangerousHtml".into(), "<script>".into());
        assert!(validate_copy_bundle(&invalid, "2026.08.17.1").is_err());
    }

    #[test]
    fn extraction_rejects_unsupported_files() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            writer
                .start_file("index.html", zip::write::FileOptions::default())
                .unwrap();
            writer.write_all(b"ok").unwrap();
            writer
                .start_file("payload.exe", zip::write::FileOptions::default())
                .unwrap();
            writer.write_all(b"bad").unwrap();
            writer.finish().unwrap();
        }
        let temp = std::env::temp_dir().join(format!("dashou-ui-test-{}", unix_millis()));
        fs::create_dir(&temp).unwrap();
        assert!(extract_zip(&temp, output.get_ref()).is_err());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn content_versions_do_not_sort_lexically() {
        assert_eq!(
            version_cmp("2026.8.17.10", "2026.8.17.2"),
            Ordering::Greater
        );
        assert_eq!(version_cmp("2026.8.17", "2026.8.17.0"), Ordering::Equal);
    }

    #[test]
    fn interrupted_ui_switch_rolls_back_and_blacklists_failed_version() {
        let root = std::env::temp_dir().join(format!("dashou-ui-state-test-{}", unix_millis()));
        let state = UiState {
            active: Some("2026.08.17.2".into()),
            previous: Some("2026.08.17.1".into()),
            pending: Some("2026.08.17.2".into()),
            last_good: Some("2026.08.17.1".into()),
            failed: Vec::new(),
        };
        write_state(&root, &state).unwrap();
        fs::write(
            root.join("state.log"),
            format!("{}\n{{interrupted", serde_json::to_string(&state).unwrap()),
        )
        .unwrap();

        let recovered = recover_interrupted_state(&root).unwrap();
        assert_eq!(recovered.active.as_deref(), Some("2026.08.17.1"));
        assert_eq!(recovered.pending, None);
        assert_eq!(recovered.failed, vec!["2026.08.17.2"]);
        assert_eq!(read_state(&root).active.as_deref(), Some("2026.08.17.1"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn updater_accepts_the_tauri_minisign_wire_format() {
        let public_text = "untrusted comment: minisign public key E7620F1842B4E81F\n\
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature_text = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1556193335\tfile:test\n\
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
        let encode = |value: &str| base64::engine::general_purpose::STANDARD.encode(value);
        assert!(
            verify_signature_with_key(b"test", &encode(signature_text), &encode(public_text))
                .is_ok()
        );
        assert!(verify_signature_with_key(
            b"tampered",
            &encode(signature_text),
            &encode(public_text)
        )
        .is_err());
    }
}
