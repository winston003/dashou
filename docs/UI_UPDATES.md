# 搭手界面与文案更新

搭手有三条明确分开的更新通道：

| 变化内容 | 用户下载 | 发布入口 |
|---|---:|---|
| 只改文字 | 通常几 KB 的 JSON | `Dashou desktop content` → `copy` |
| 改 HTML、CSS 或前端 JavaScript | 通常几十 KB 的签名 ZIP | `Dashou desktop content` → `ui` |
| 改 Rust、系统权限、Tauri 插件、本地服务或随包程序 | 完整 DMG / EXE | `Dashou desktop` |

不要为了改一句话发布完整安装包，也不要用 UI 小包绕过外壳权限边界。

## 发布文字或界面

1. 在正式仓库完成修改并通过 `npm run verify:pilot-release`。
2. 提交并推送修改。
3. 在 GitHub Actions 运行 **Dashou desktop content**。
4. 选择 `copy`、`ui` 或 `both`，填写单调递增的内容版本，例如 `2026.08.17.1`。
5. `min_shell_version` 填这份内容能够支持的最旧搭手外壳版本。

工作流会构建内容、使用与 Tauri updater 相同的 Minisign 私钥签名，再更新公开发布仓库中的稳定内容入口。客户端每次启动后检查一次，之后每 6 小时检查一次；更新界面不会停止本地搭手服务。

## 安全与回滚

- 安装包始终包含可离线启动的内置页面。
- 下载地址只允许 GitHub HTTPS 发布资源。
- 客户端同时验证文件大小、SHA-256 和 Minisign 签名。
- UI ZIP 拒绝路径穿越、软链接、未知文件类型、过多文件和异常展开体积。
- 新 UI 启用后必须调用 `ui_ready(version)`；若应用在确认前退出，下次启动自动回到上一版。
- 回滚过的内容版本会被本机拒绝，修复后必须发布更高版本。
- 只保留当前版、上一版和最后确认可用版。
- 自定义 `dashou-ui://` 协议只读取已验证目录，并对响应施加严格 CSP。
- 文案 JSON 只能覆盖允许的键，每条文案限制长度，不能注入 HTML。

## 什么时候必须升级完整外壳

下列变化不能通过 UI 或文案包发布：

- 新增或扩大系统权限；
- 新增 Tauri 插件或原生命令；
- 修改 Rust 代码、MCP/runtime、`cloudflared` 或 Node 运行时；
- 修改签名公钥、协议版本或安全校验逻辑；
- 新 UI 要求高于当前 `bridgeVersion` 的原生能力。

这些变化仍需新的已签名 Windows 安装包，以及经过 Developer ID 签名和 Apple 公证的 macOS 安装包。
