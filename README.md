# 搭手 Dashou

让 ChatGPT 走进你的本地工作空间，帮你把事情做完。

![搭手：你的本地工作搭档](assets/brand/dashou-hero.jpg)

搭手是一款桌面工具。安装后，你可以让 ChatGPT 在自己选择的工作文件夹中读取项目、修改代码、运行测试和执行命令。你只需要描述想做什么，不必在 ChatGPT 和电脑之间反复复制粘贴。

> 本地执行 · 由你授权 · 结果可见 · 随时停止

## 给第一次使用的人

### 五步开始

1. 从[最新版本](https://github.com/winston003/dashou-releases/releases/latest)下载并安装搭手。
2. 打开搭手，点击“开始使用搭手”，等待准备完成。
3. 选择一个或多个你愿意使用的工作文件夹。
4. 点击“连接 ChatGPT”，跟着客户端里的 1/3 → 2/3 → 3/3 创建并授权搭手。
5. 客户端显示“ChatGPT 已连接”后，点击“复制任务并打开 ChatGPT”，完成第一个只读检查。

搭手不会主动浏览你的电脑。文件读取和修改限制在你选择的文件夹中；项目命令会使用当前电脑账户的权限。你可以随时添加、移除文件夹，或从菜单栏退出搭手。

例如，你可以直接说：

> 先看看这个项目现在是什么状态，然后修复测试失败的问题，最后运行测试并告诉我改了什么。

普通用户只需要看上面的安装流程；下面的内容是给开发者、管理员和内测维护者看的。

当前版本的目标不是做完整 Agent OS，而是验证一个最小产品假设：用户是否愿意持续使用 ChatGPT 直接完成本地工作，并为这种便利付费。

Dashou 吸收了 DevSpace v3 中与这个最小链路直接相关的运行可靠性改进：`doctor` 在 Node
运行时不匹配时仍可启动并给出修复信息；`serve` 对同一个状态目录只允许一个实例；经过反向代理
时只信任一跳 forwarded 地址；关闭服务时先停止接收请求，再关闭 OAuth/MCP 状态。DevSpace v3
的 Task、Lease、Review、Multi-Agent 和 Task Pulse 治理不进入 V0，以保持 ChatGPT 只看到少量、清晰的工具。

## V0 能力

ChatGPT 只看到 6 个工具：

- `list_projects`：列出用户明确授权的项目目录，不扫描整个磁盘。
- `open_project`：打开一个已经授权的本地项目目录。
- `read`：读取项目内文本文件。
- `write`：创建或完整覆盖文本文件。
- `edit`：对文本文件做明确、可审查的局部修改。
- `execute`：在项目目录内执行命令、测试、构建、Git 检查和搜索。

V0 默认不开放 Task、多 Agent、Review、Lease、Worktree、Skills、Cloud Workspace 或长期 Memory。
项目根目录的 `AGENTS.md` / `CLAUDE.md` 规则会在 `open_project` 时加载；嵌套规则会被发现并要求模型在进入对应目录前读取。

## 安全边界

- 只能打开初始化时明确授权的目录。
- 文件路径必须保持在授权根目录内。
- 模型侧要求文件修改通过 `write` / `edit`，命令通过 `execute` 明确发生；这样变更边界更清楚。
- `execute` 默认关闭。用户在客户端设置中主动开启后，它拥有本地用户的命令执行权限，运行的程序本身仍可能访问授权目录之外的内容。它**不是操作系统沙箱**；搭手会剥离服务端、云端和常见开发凭据，并额外拦截少数明显危险命令。
- 文件工具会同时检查授权根目录、项目边界和符号链接逃逸；`write` / `edit` 使用同目录原子替换。
- OAuth 客户端和 Token 使用轻量 JSON 状态持久化，不再依赖 SQLite。
- 搭手的配置和授权信息与 DevSpace 隔离，默认写入 `~/.dashou`；运行状态默认写入 `~/.local/share/dashou`。

## 本地开发

要求 Node `>=22.19 <27`。

```bash
npm install
npm test
npm run build
npm run verify:pilot
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

发布前检查：

```bash
npm run verify:release   # typecheck、完整测试、build、生产依赖审计
npm run pack:pilot       # 通过检查后生成当前版本的 releases/warmbyte-dashou-<version>.tgz
```

安装包 smoke 会在全新临时环境验证安装、`doctor --json`、OAuth、Streamable HTTP
以及六个工具的项目发现、文本读写和命令执行闭环：

```bash
npm run verify:pilot
```

`verify:pilot` 会自动先生成当前版本的临时发布包，因此可以单独执行；`pack:pilot`
则会在完整发布门禁后继续执行同一套安装、OAuth、六工具和升级验证。

正式桌面内测由用户在客户端申请，管理员用 CLI 审核，不再正常传递邀请文件：

```bash
dashou admin applications list
dashou admin applications approve req_xxx --period month --subject customer-alice
```

`week`、`month`、`quarter`、`year` 是授权周期。旧版邀请文件只作为兼容和故障恢复入口保留：

```bash
dashou pilot invite --interactive
```

如果需要验证公网 HTTPS、反向代理、OAuth 和 MCP 链路，可运行：

```bash
npm run verify:public
```

它会启动一个隔离测试目录、Dashou 和临时 Cloudflare Quick Tunnel，完成公网健康检查、OAuth、
六工具列表以及读取、文本修改和命令执行闭环后自动关闭。Quick Tunnel 没有稳定域名；该命令也不代表真实
ChatGPT UI 或真实用户验收。

安装后的诊断和升级检查：

```bash
dashou doctor --json
dashou upgrade --check
```

要自动验证“全新安装 → 公网连接 → OpenAI/ChatGPT 发送消息 → 本地读取、修改、执行”，可对一次性
临时目录运行 Responses API 链路：

```bash
OPENAI_API_KEY='由用户自己注入' npm run verify:openai:local
```

该命令会安装当前包到临时目录，启动 Dashou 和一次性 Cloudflare Quick Tunnel，让模型发送真实
Responses API 消息并导入六个工具，最后检查临时文件和命令输出。写入、修改和执行只作用于该命令
创建的临时目录；需要明确设置 `OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1` 才会自动批准变更工具：

```bash
OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1 OPENAI_API_KEY='由用户自己注入' npm run verify:openai:local
```

这是 OpenAI Responses API 的自动化证据，不等于 ChatGPT 网页 UI；真实 ChatGPT UI 仍需在一个已登录
且允许连接自定义 MCP 的账号中完成一次用户任务。

`upgrade --check` 只检查受信任 GitHub Release 的 CLI 专用清单，不会自动替换 npm 安装。
当前清单地址可用 `DASHOU_UPDATE_MANIFEST_URL` 覆盖；桌面 Tauri 的 `latest.json` 和
npm/CLI 的 `cli-latest.json` 是两种格式，不能混用。CLI 清单发布前，该命令会明确报告
清单尚未提供，不会误把桌面安装包当作 CLI 更新。

明确需要升级时运行 `dashou upgrade --apply`。它只接受受信任的 npm/GitHub CLI tarball，
下载后先校验清单中的 SHA-256，再调用 npm 全局安装；清单缺少哈希或校验失败时不会安装。

受控内测的正常路径是 Cloudflare Worker + D1 控制面：桌面设备申请，管理员按周期批准，控制面自动创建每设备 Tunnel/DNS，桌面端自动领取配置。连接密码仍只在本地生成。`DASHOU_PILOT_ENABLED`、`DASHOU_PILOT_ACCOUNT_ID` 和 `DASHOU_PILOT_EXPIRES_AT` 仅保留给本地开发与兼容演练。

如果已经有 Warmbyte 控制面，可配置 `DASHOU_PILOT_POLICY_URL`、临时注入的
`DASHOU_PILOT_POLICY_TOKEN` 和签名验证用的 `DASHOU_PILOT_POLICY_PUBLIC_KEY`。控制面返回
短期 signed lease；搭手只在首次激活或没有合法本地 lease 时同步获取，之后由后台刷新；健康检查、OAuth
和 access token 校验只做本地签名与 expiry 验证，不把控制面放进 MCP 请求热路径。合法 lease 在短暂断网
或重启时继续有效，撤销在下次刷新或 lease 到期时生效；本机和远端 expiry 取更早者。非 loopback
控制面必须使用 HTTPS。

本仓库同时保留一个最小的单机控制面供离线兼容测试：
`DASHOU_PILOT_CONTROL_ADMIN_TOKEN=... DASHOU_PILOT_CONTROL_LEASE_PRIVATE_KEY=... dashou pilot-control`。
它支持旧账号创建、启用/禁用、修改到期时间和撤销；正式设备申请控制面见 `control-plane/README.md`。当前周/月/季/年只表示授权周期，尚未接入真实计费、审计后台或高可用架构。

如果已经有可访问的公网 MCP 地址和 API key，可以运行 `npm run verify:openai` 做一次
OpenAI Responses API remote-MCP smoke。它会检查 Responses API 导入的正好六个工具并发送真实消息；
默认只自动允许 `open_project` / `read`，写入、修改和执行会停在 approval。只有对一次性测试目录明确设置
`OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1` 才会继续。这个结果是 OpenAI API 证据，不等于 ChatGPT UI 证据。

## 产品边界

V0 的唯一核心问题：

> 一个普通 ChatGPT 用户安装搭手后，是否因为能够直接操作本地文件和运行命令而明显减少复制粘贴、切换工具和手工操作，并愿意持续付费？

只有真实内测证明这个价值后，才考虑逐步加入 Project Continuity、Memory、Task、多 Agent Handoff 和 Cloud Workspace。

## 来源与许可

搭手 V0 的本地 MCP 执行原语基于 Waishnav/DevSpace v1.0.6（MIT License）进行产品化收敛。原项目的 MIT License 保留在本仓库 `LICENSE` 中。搭手后续新增能力独立演进。
