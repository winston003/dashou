# Dashou Desktop

Dashou Desktop 是面向普通用户的 Tauri 安装包；npm 主要保留给开发者和管理员 CLI。

应用内置经过固定版本与校验的 Node 22、Dashou 服务和对应平台的 `cloudflared`。用户配置、设备申请凭据、Tunnel/试用授权和 OAuth 状态只保存在 Tauri application data 目录；连接密码只在本机生成，不发送给控制面。

## 首次使用

```text
安装 → 申请开通 → 等待管理员批准 → 选择一个或多个文件夹
→ 开始使用 → 去 ChatGPT 连接 → 需要时复制授权密码
```

批准后，桌面端自动领取设备专属 Tunnel、MCP 地址和受控试用授权；保存成功后向 Worker 确认清除暂存密文。`.dashou-invite.json` 只保留为旧版本兼容与故障恢复入口。

应用启动时及每六小时检查 GitHub Release 更新。下载必须通过 Tauri 签名验证后才会安装和重启。

## 本地开发

从仓库根目录运行：

```bash
npm run desktop:install
npm run desktop:dev
```

本地测试控制面可以覆盖：

```bash
DASHOU_CONTROL_BASE_URL=http://127.0.0.1:8787 npm run desktop:dev
```

构建本地安装包：

```bash
DASHOU_CLOUDFLARED_BINARY=/absolute/path/to/cloudflared npm run desktop:build
```

构建会在未配置真实 Tauri updater 公钥时停止。只在发布环境通过 `desktop/scripts/configure-release.mjs` 配置公钥；updater 私钥不得提交。

桌面外壳支持签名文案包和签名 UI 小包。发布边界、自动回滚和 GitHub Actions 操作见 [`../docs/UI_UPDATES.md`](../docs/UI_UPDATES.md)。

CI 分别构建 macOS Apple Silicon、Intel 与 Windows NSIS 安装包，并校验固定的 Cloudflare `cloudflared` 资产。受控 macOS 内测包使用 Tauri 官方支持的 ad-hoc 签名，仍可能要求用户在“隐私与安全”中明确允许；面向广泛公众分发前必须换成 Apple Developer ID/notarization，并为 Windows 配置 Authenticode。
