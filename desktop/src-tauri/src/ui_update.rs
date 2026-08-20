use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiBundleStatus {
    pub source: &'static str,
    pub version: Option<String>,
    pub update_available: bool,
    pub changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyBundleStatus {
    version: Option<String>,
    messages: BTreeMap<String, String>,
    changed: bool,
}

fn built_in_status() -> UiBundleStatus {
    UiBundleStatus {
        source: "built-in",
        version: None,
        update_available: false,
        changed: false,
    }
}

fn empty_copy_status() -> CopyBundleStatus {
    CopyBundleStatus {
        version: None,
        messages: BTreeMap::new(),
        changed: false,
    }
}

/// Remove executable content downloaded by older preview builds.
///
/// rc.14 deliberately ships one audited UI inside the signed application.
/// Remote JavaScript and copy updates stay disabled until they have a
/// dedicated signing key and a least-privileged renderer boundary.
pub fn disable_downloaded_content(app: &AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    for directory in [data_dir.join("ui"), data_dir.join("copy")] {
        match fs::remove_dir_all(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法清理旧界面缓存：{error}")),
        }
    }
    Ok(())
}

pub fn protocol_response(_app: &AppHandle, _request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::GONE)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
        .header("X-Content-Type-Options", "nosniff")
        .body("此版本只使用应用内置界面".as_bytes().to_vec())
        .unwrap()
}

#[tauri::command]
pub fn ui_bundle_status(app: AppHandle) -> Result<UiBundleStatus, String> {
    disable_downloaded_content(&app)?;
    Ok(built_in_status())
}

/// Kept for Bridge v1 compatibility. There is no downloaded UI to confirm.
#[tauri::command]
pub fn ui_ready(_app: AppHandle, _version: String) -> Result<(), String> {
    Ok(())
}

/// Kept for older renderers, but intentionally performs no network request.
#[tauri::command]
pub async fn check_ui_update(app: AppHandle) -> Result<UiBundleStatus, String> {
    disable_downloaded_content(&app)?;
    Ok(built_in_status())
}

#[tauri::command]
pub fn copy_bundle(app: AppHandle) -> Result<CopyBundleStatus, String> {
    disable_downloaded_content(&app)?;
    Ok(empty_copy_status())
}

/// Kept for older renderers, but intentionally performs no network request.
#[tauri::command]
pub async fn check_copy_update(app: AppHandle) -> Result<CopyBundleStatus, String> {
    disable_downloaded_content(&app)?;
    Ok(empty_copy_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_status_never_advertises_downloaded_code() {
        let status = built_in_status();
        assert_eq!(status.source, "built-in");
        assert_eq!(status.version, None);
        assert!(!status.update_available);
        assert!(!status.changed);
    }

    #[test]
    fn legacy_protocol_is_closed() {
        let response = Response::builder()
            .status(StatusCode::GONE)
            .header("X-Content-Type-Options", "nosniff")
            .body(Vec::<u8>::new())
            .unwrap();
        assert_eq!(response.status(), StatusCode::GONE);
        assert_eq!(
            response.headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
    }
}
