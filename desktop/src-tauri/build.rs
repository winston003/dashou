fn main() {
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read("tauri.conf.json").expect("tauri.conf.json must be readable"),
    )
    .expect("tauri.conf.json must be valid JSON");
    let public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .expect("plugins.updater.pubkey must be configured");
    println!("cargo:rustc-env=DASHOU_UI_PUBLIC_KEY={public_key}");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
