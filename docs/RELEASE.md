# 桌面安装包发布流程

客服永远只发送这个公开入口：

```text
https://github.com/winston003/dashou-releases/releases/latest
```

Release 页面按平台明确列出安装文件，并内置首次使用说明。具体提交变化由 GitHub 自动生成，固定安装说明由源仓库工作流维护。

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

> 请打开搭手官方下载页，按你的电脑选择 Mac 或 Windows 安装包。安装后点击“申请开通”，页面显示等待审核就可以，不需要填写任何网络信息。审核通过后，选择要让 ChatGPT 使用的文件夹，再点击“去 ChatGPT 连接”。

客服不发送 Tunnel Token、内测连接码、连接密码或源码仓库命令。旧 `.dashou-invite.json` 只在控制面故障恢复时由管理员明确使用。
