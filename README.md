# 搭手 Dashou

让 ChatGPT 直接、安全地操作你明确授权的本地文件和项目。

搭手是一个本地 MCP 执行器。它运行在用户自己的电脑上，把少量、清晰的本地能力提供给 ChatGPT：打开项目、读取文件、写入文件、修改文件和执行命令。

当前版本的目标不是做完整 Agent OS，而是验证一个最小产品假设：用户是否愿意持续使用 ChatGPT 直接完成本地工作，并为这种便利付费。

## V0 能力

ChatGPT 只看到 5 个工具：

- `open_project`：打开一个已经授权的本地项目目录。
- `read`：读取项目内文件。
- `write`：创建或完整覆盖文件。
- `edit`：对文件做明确、可审查的局部修改。
- `execute`：在项目目录内执行命令、测试、构建、Git 检查和搜索。

V0 默认不开放 Task、多 Agent、Review、Lease、Worktree、Skills、Cloud Workspace 或长期 Memory。

## 安全边界

- 只能打开初始化时明确授权的目录。
- 文件路径必须保持在授权根目录内。
- 模型侧要求文件修改优先通过 `write` / `edit` 显式发生；这样变更边界更清楚。
- `execute` 拥有本地用户的命令执行权限，运行的程序本身仍可能修改文件，因此必须通过 OAuth 连接密码保护。它**不是操作系统沙箱**；V0 只额外拦截少数明显危险命令。
- 文件工具会同时检查授权根目录、项目边界和符号链接逃逸；`write` / `edit` 使用同目录原子替换。
- OAuth 客户端和 Token 使用轻量 JSON 状态持久化，不再依赖 SQLite。
- 搭手的配置和授权信息与 DevSpace 隔离，默认写入 `~/.dashou`；运行状态默认写入 `~/.local/share/dashou`。

## 本地开发

要求 Node `>=22.19 <27`。

```bash
npm install
npm test
npm run build
node dist/dashou-cli.js init
node dist/dashou-cli.js serve
```

未来独立发布后，目标使用方式是：

```bash
npm install -g @warmbyte/dashou
dashou init
dashou serve
```

初始化时需要：

1. 选择 ChatGPT 可以访问的本地目录。
2. 填写一个指向本地搭手服务的公网 HTTPS 地址，例如内测管理员分配的 Cloudflare Tunnel 域名。
3. 可选：粘贴对应 Tunnel Token。配置后 `dashou serve` 会同时启动 `cloudflared`；留空则继续使用外部维护的 Tunnel。
4. 保存生成的连接密码，在 ChatGPT 首次连接时进行 OAuth 授权。

Tunnel Token 与连接密码都只保存在 `~/.dashou/auth.json`（权限 `0600`），不会写进普通配置文件。搭手把 Tunnel Token 放入 `cloudflared` 的环境变量，不放到进程参数里。

默认本地端口为 `7677`，避免与现有 DevSpace `7676` 冲突。MCP App / Template UI 不属于 V0 核心链路，ChatGPT 默认直接使用原生工具展示。

第一轮内测流程见 `docs/PILOT.md`。

## 产品边界

V0 的唯一核心问题：

> 一个普通 ChatGPT 用户安装搭手后，是否因为能够直接操作本地文件和运行命令而明显减少复制粘贴、切换工具和手工操作，并愿意持续付费？

只有真实内测证明这个价值后，才考虑逐步加入 Project Continuity、Memory、Task、多 Agent Handoff 和 Cloud Workspace。

## 来源与许可

搭手 V0 的本地 MCP 执行原语基于 Waishnav/DevSpace v1.0.6（MIT License）进行产品化收敛。原项目的 MIT License 保留在本仓库 `LICENSE` 中。搭手后续新增能力独立演进。
