# 桌面安装包发布流程

只修改文字或桌面 HTML/CSS/JavaScript 时，不需要让用户重新下载完整安装包。使用 [UI_UPDATES.md](UI_UPDATES.md) 中的签名内容发布流程；原生能力、权限、本地服务和随包程序变化仍走本文件的完整安装包流程。

客服永远只发送这个公开入口：

```text
https://github.com/winston003/dashou-releases/releases/latest
```

Release 页面按平台明确列出安装文件，并内置首次使用说明。具体提交变化由 GitHub 自动生成，固定安装说明由源仓库工作流维护。面向用户的图文版安装步骤见 [GETTING_STARTED.md](GETTING_STARTED.md)。

## Release 页面必须包含的内容

每个桌面 Release 的正文都要保留下面这组信息，不要只贴构建产物名称：

1. Mac Apple Silicon、Mac Intel、Windows 三个下载入口。
2. macOS 免费内测包的首次打开说明：应用程序 → 右键 Dashou → 打开 → 打开。
3. 一句话说明：安装后打开搭手，点击“开始使用搭手”；准备好后选择文件夹。
4. “连接 ChatGPT”按钮和客户端 1/3 → 2/3 → 3/3 引导的说明与截图。
5. ChatGPT 插件页的直接入口：<https://chatgpt.com/plugins?view=personal>。
6. 如果页面没有“创建应用”，明确告诉用户去 ChatGPT **设置 → 插件 → 开发者模式**，勾选 **“开发人员模式”** 和 **“在开发者模式下强制执行 CSP”**；工作区管理员则使用 **工作区设置（Workspace settings）→ 应用（Apps）→ 创建（Create）**。
7. 关闭窗口只会收起搭手；搭手会留在 macOS 顶部菜单栏。要停止它，从菜单栏选择“退出搭手”。
8. 本版本最近变化，以及已知限制。

不要在 Release 正文或截图中放入本机绝对路径、连接密码、Tunnel Token、OAuth 信息或管理员 token。

可直接复制的 Release 正文模板：

```markdown
## 下载

- [Mac Apple Silicon](https://github.com/winston003/dashou-releases/releases/download/desktop-<version>/dashou-<version>-darwin-aarch64.dmg)
- [Mac Intel](https://github.com/winston003/dashou-releases/releases/download/desktop-<version>/dashou-<version>-darwin-x86_64.dmg)
- [Windows](https://github.com/winston003/dashou-releases/releases/download/desktop-<version>/dashou-<version>-windows-x86_64-setup.exe)

macOS 免费内测版第一次安装时，会看到下面这个“应用程序 + Dashou”窗口：

![macOS 安装窗口](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/macos-dmg-install-window.jpg)

## 5 分钟开始使用

1. Mac 内测版第一次打开：把 Dashou 拖到“应用程序”，然后在“应用程序”中右键 Dashou，选择“打开”，再确认一次“打开”。Windows 用户直接运行安装包。
2. 安装并打开搭手，点击“开始使用搭手”。
3. 搭手准备好后，点击“添加文件夹”，选择一个或多个工作文件夹，再点击“开始使用”。
4. 点击“连接 ChatGPT”。搭手会自动复制地址并打开 ChatGPT，再按客户端的 1/3 → 2/3 → 3/3 引导完成创建和授权。
5. 客户端显示“ChatGPT 已连接”后，点击“复制任务并打开 ChatGPT”，完成第一个只读项目列表。

ChatGPT 插件页：[直接打开](https://chatgpt.com/plugins?view=personal)。

![搭手首次设置](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/first-setup.jpg)

macOS 免费内测版的安装图文说明：[打开 macOS 安装说明](https://github.com/winston003/dashou/blob/main/docs/MACOS_INSTALL.md)。

![搭手开始连接 ChatGPT](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/connect-03-client-start.png)

![搭手提供创建应用所需内容](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/connect-04-copy-fields.png)

如果看不到“创建应用”：打开 ChatGPT **设置 → 插件 → 开发者模式**，勾选 **“开发人员模式”** 和 **“在开发者模式下强制执行 CSP”**；工作区管理员可从 **工作区设置（Workspace settings）→ 应用（Apps）→ 创建（Create）** 进入。打开后返回个人页。

官方说明：[Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)

关闭搭手窗口不会停止服务；它会收起到 macOS 顶部菜单栏。需要停止服务时，在菜单栏选择“退出搭手”。

## 最近变化

- …

完整图文说明：[GETTING_STARTED.md](https://github.com/winston003/dashou/blob/main/docs/GETTING_STARTED.md)
```

## 发布顺序

1. 在干净、已审核的提交上运行完整本地门禁。
2. 先部署 Control Plane，应用 D1 migrations，核对 `/healthz` 的版本与提交。
3. 在源仓库创建 `desktop-v<version>` tag。
4. GitHub Actions 分别构建 macOS Apple Silicon、macOS Intel 和 Windows NSIS。
5. 发布任务再次检查线上 Control Plane 版本与 tag 版本一致；不一致就拒绝发布客户端。
6. 发布到独立公开仓库 `winston003/dashou-releases`，生成 updater `latest.json` 和安装文件。
7. 用一台全新/清理过应用数据的电脑走完申请、审批、自动领取、ChatGPT OAuth 和第一个真实任务。

## macOS 签名与公证凭据（仅维护者）

这些凭据只存在于 GitHub Actions Secrets，普通用户不会看到，也不会输入 Apple 账号信息。CI 使用 App Store Connect API Key 公证，不使用 Apple 账号专用密码：

- `APPLE_CERTIFICATE`：`Developer ID Application` `.p12` 的 Base64 内容。
- `APPLE_CERTIFICATE_PASSWORD`：导出 `.p12` 时设置的密码。
- `APPLE_API_KEY_CONTENT`：App Store Connect API Key 私钥 `.p8` 的 Base64 内容。
- `APPLE_API_KEY`：API Key 的 Key ID。
- `APPLE_API_ISSUER`：App Store Connect 的 Issuer ID。

Tauri 官方支持这组三项 API Key 变量进行 macOS 公证；API Key 应创建为 Developer access，并且 `.p8` 私钥只能下载一次，必须立即安全保存。参见 [Tauri macOS signing](https://tauri.app/distribute/sign/macos/)。

不要把 `APPLE_ID`、`APPLE_PASSWORD` 或 `APPLE_TEAM_ID` 放进这个仓库的 CI；Apple ID 方式只作为维护者本地排障的备用方式。

## 发布前命令

```bash
npm run verify:release
npm run verify:control-plane
npm run verify:desktop
```

## macOS 免费内测模式

当前没有 Apple Developer 账号时，GitHub Actions 默认使用 `adhoc` 模式构建 macOS 内测包。这个包可以安装和运行，但用户第一次打开时需要在“应用程序”中右键 Dashou，选择“打开”，再确认一次“打开”。它不会通过 Apple 公证，因此不能承诺消除 macOS 的首次安全提示。

手动运行工作流时，`macos_signing_mode` 保持 `adhoc`。以后完成 Apple Developer 配置后，再选择 `developer-id`；该模式才会要求并使用 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_KEY_CONTENT`、`APPLE_API_KEY` 和 `APPLE_API_ISSUER`。

控制面部署脚本拒绝脏工作树：

```bash
npm run deploy:control-plane
```

审核并提交后才创建 tag；不要从当前未提交工作树发布。

## 客服话术

> 请使用我发给你的 Mac 或 Windows 安装包。安装后点击“开始使用搭手”，准备好后选择工作文件夹，再点击“连接 ChatGPT”。接下来跟着客户端的 1/3 → 2/3 → 3/3 操作即可，不需要记地址或密码。

客服不发送 Tunnel Token、内测连接码、连接密码或源码仓库命令。旧 `.dashou-invite.json` 只在控制面故障恢复时由管理员明确使用。
