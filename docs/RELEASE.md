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
2. 一句话说明：安装后打开搭手，加入试用；搭手准备好后选择文件夹。
3. “去 ChatGPT 连接”按钮的下一步说明和截图。
4. ChatGPT 插件页的直接入口：<https://chatgpt.com/plugins?view=personal>。
5. 如果页面没有“创建应用”，明确告诉用户去 ChatGPT **设置 → 应用（Apps）→ 高级设置（Advanced settings）→ 开发者模式（Developer mode）**；工作区管理员则使用 **工作区设置（Workspace settings）→ 应用（Apps）→ 创建（Create）**。
6. 关闭窗口只会收起搭手；搭手会留在 macOS 顶部菜单栏。要停止它，从菜单栏选择“退出搭手”。
7. 本版本最近变化，以及已知限制。

不要在 Release 正文或截图中放入本机绝对路径、连接密码、Tunnel Token、OAuth 信息或管理员 token。

可直接复制的 Release 正文模板：

```markdown
## 下载

- [Mac Apple Silicon](https://github.com/winston003/dashou-releases/releases/download/desktop-<version>/dashou-<version>-darwin-aarch64.dmg)
- [Mac Intel](https://github.com/winston003/dashou-releases/releases/download/desktop-<version>/dashou-<version>-darwin-x86_64.dmg)
- [Windows](https://github.com/winston003/dashou-releases/releases/download/desktop-<version>/dashou-<version>-windows-x86_64-setup.exe)

## 5 分钟开始使用

1. 安装并打开搭手，点击“加入试用”。
2. 搭手准备好后，点击“添加文件夹”，选择一个或多个工作文件夹，再点击“开始使用”。
3. 点击“去 ChatGPT 连接”。搭手会自动复制地址并打开 ChatGPT。
4. 在 ChatGPT“个人”页点击“创建应用”，粘贴地址；需要密码时回到搭手点击“复制授权密码”。

ChatGPT 插件页：[直接打开](https://chatgpt.com/plugins?view=personal)。

![搭手首次设置](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/first-setup.jpg)

![搭手已准备好](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/ready-to-connect.jpg)

![ChatGPT 中的搭手连接详情](https://raw.githubusercontent.com/winston003/dashou/desktop-v<version>/docs/images/chatgpt-connection.jpg)

如果看不到“创建应用”：打开 ChatGPT **设置 → 应用（Apps）→ 高级设置（Advanced settings）→ 开发者模式（Developer mode）**；工作区管理员可从 **工作区设置（Workspace settings）→ 应用（Apps）→ 创建（Create）** 进入。打开后返回个人页。

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

## 发布前命令

```bash
npm run verify:release
npm run verify:control-plane
npm run verify:desktop
```

控制面部署脚本拒绝脏工作树：

```bash
npm run deploy:control-plane
```

审核并提交后才创建 tag；不要从当前未提交工作树发布。

## 客服话术

> 请打开搭手官方下载页，按你的电脑选择 Mac 或 Windows 安装包。安装后点击“加入试用”，其余准备会自动完成，不需要填写网络信息。搭手准备好后，选择要让 ChatGPT 使用的文件夹，再点击“去 ChatGPT 连接”。

客服不发送 Tunnel Token、内测连接码、连接密码或源码仓库命令。旧 `.dashou-invite.json` 只在控制面故障恢复时由管理员明确使用。
