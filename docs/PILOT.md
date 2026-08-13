# 搭手 V0 内测手册

目标不是收集“觉得好不好”，而是验证：用户是否真的用 ChatGPT 完成本地工作，并在一周内重复使用。

## 管理员准备

每个内测用户分配一套独立入口：

- 一个稳定子域名，例如 `alice.warmbyte.studio`。
- 一个独立的 Cloudflare remotely-managed Tunnel。
- Tunnel 的 Public Hostname 指向用户电脑上的 `http://127.0.0.1:7677`。
- 该 Tunnel 的 token。

不要让多个用户共用同一个 Tunnel token。token 只发给对应用户，不写入聊天、Issue 或共享文档。

## 用户安装

要求：

- Node.js >= 22.19 < 27
- `cloudflared`
- 可以正常使用 ChatGPT

正式 npm 发布后安装：

```bash
npm install -g @warmbyte/dashou
dashou init
```

在 npm 发布前，管理员可从正式仓库生成内测包：

```bash
npm run pack:pilot
```

然后把当前生成的 `releases/warmbyte-dashou-<version>.tgz` 单独发给内测用户，用户执行：

```bash
npm install -g ./warmbyte-dashou-<version>.tgz
dashou init
```

`pack:pilot` 会先执行完整发布门禁；验证安装包闭环可运行：

```bash
npm run verify:pilot
```

安装完成后，管理员和用户可先检查：

```bash
dashou doctor --json
dashou upgrade --check
```

如果要一次性验证新包的完整模型链路，使用仓库内的 OpenAI Responses API smoke：

```bash
OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1 OPENAI_API_KEY='由用户自己注入' npm run verify:openai:local
```

它会在临时目录安装当前包，启动一次性公网入口，让模型发送消息并完成 `open_project`、`read`、
`write`、`edit`、`execute`，最后核对文件和命令输出。该命令不会触碰用户项目；API key 不要写入
聊天或日志。结果属于 OpenAI Responses API 证据，不代表 ChatGPT 网页 UI 验收。

发布前或更换 Tunnel 后，可用仓库内的公网 smoke 复核整条兼容客户端链路：

```bash
npm run verify:public
```

该命令使用临时 Cloudflare Quick Tunnel 和一次性测试目录，验证公网 HTTPS、OAuth、五个 MCP
工具以及本地读写修改执行；它完成后会自动关闭。结果明确属于兼容 MCP 客户端证据，不等于
ChatGPT UI 或首个真实用户任务。

`doctor --json` 用于确认运行时、配置、受控试用状态和五工具能力契约；
`upgrade --check` 只报告 GitHub Release 中是否有新版本，不会自动升级 npm 全局安装。
它要求 CLI/npm 专用的 `cli-latest.json`；不能直接复用桌面 Tauri 的 `latest.json`。
如果 CLI 清单尚未发布，检查失败是预期的，并不表示桌面 Release 可用于 CLI。
确认要升级时运行 `dashou upgrade --apply`；它下载并校验 CLI 专用 tarball 的 SHA-256 后，
再调用 npm 全局安装。桌面 `latest.json`、DMG 或 `.app.tar.gz` 不会被当作 CLI 包。

如果需要限制一个本机内测实例，可设置：

```bash
export DASHOU_PILOT_ENABLED=1
export DASHOU_PILOT_ACCOUNT_ID=pilot-alice
export DASHOU_PILOT_EXPIRES_AT=2026-09-01T00:00:00.000Z
```

这只是本机策略：到期或禁用后 `/healthz`、OAuth 和 MCP 会拒绝访问。`ACCOUNT_ID` 目前
用于标识和诊断，不代表已经实现远程账号系统、计费、用户隔离、Tunnel 自动发放或撤销。

如果管理员已有控制面，可改用远程策略：

```bash
export DASHOU_PILOT_POLICY_URL=https://control.example/pilot-policy
export DASHOU_PILOT_POLICY_TOKEN='由管理员安全注入，不要写入聊天或日志'
export DASHOU_PILOT_POLICY_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----'
export DASHOU_PILOT_POLICY_CACHE_TTL_SECONDS=300
```

接口返回签名 lease：

```json
{"lease":"<base64url-payload>.<base64url-rsa-pss-signature>"}
```

控制面只负责签发和刷新 lease；健康检查、OAuth 和 access token 校验只验证本地缓存的签名 lease。
合法 lease 支持短时间离线工作；撤销在下一次刷新或 lease 到期时生效。本机和远端 expiry 取更早者。
非 loopback 的控制面地址必须是 HTTPS。控制面不可达不会让每个 MCP 请求或已有合法 lease 的重启同步等待
网络；只有首次激活或本地没有合法 lease 时，服务才会同步尝试获取新 lease。

本仓库还可以启动一个最小单机控制面供首批内测使用：

```bash
export DASHOU_PILOT_CONTROL_ADMIN_TOKEN='管理员自己生成的长随机值'
export DASHOU_PILOT_CONTROL_LEASE_PRIVATE_KEY='管理员安全保存的 RSA 私钥 PEM'
dashou pilot-control
```

默认监听 `127.0.0.1:8787`，可用 `DASHOU_PILOT_CONTROL_HOST`、
`DASHOU_PILOT_CONTROL_PORT` 和 `DASHOU_PILOT_CONTROL_STATE_DIR` 调整。管理员创建账号：

```bash
curl -sS -X POST http://127.0.0.1:8787/admin/pilot/accounts \
  -H "Authorization: Bearer $DASHOU_PILOT_CONTROL_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"pilot-alice","expiresAt":"2026-09-01T00:00:00.000Z"}'
```

响应里的 `token` 只交给对应内测用户，并配置在 Dashou 客户端的
`DASHOU_PILOT_POLICY_TOKEN`；控制面地址配置为 `DASHOU_PILOT_POLICY_URL`。
管理员可对 `/admin/pilot/accounts/pilot-alice` POST `{"enabled":false}` 禁用，或
`{"revoke":true}` 撤销。控制面 token 和用户 token 都不要写进聊天、Issue 或日志。

也可以使用仓库根目录的管理员命令代替手写 curl：

```bash
export DASHOU_PILOT_CONTROL_URL=https://dashou-pilot-control.whilewon.workers.dev
export DASHOU_PILOT_CONTROL_ADMIN_TOKEN='只在管理员终端注入'
npm run pilot:admin -- list
npm run pilot:admin -- create pilot-alice 2026-09-01T00:00:00.000Z
npm run pilot:admin -- disable pilot-alice
npm run pilot:admin -- revoke pilot-alice
```

`.tgz` 是临时分发方式，不需要内测用户拿到源码仓库。

初始化只需要回答四件事：

1. ChatGPT 可以访问哪个本地目录。
2. 本地端口，默认 `7677`。
3. 管理员分配的 `https://xxx.warmbyte.studio`。
4. 管理员分配的 Tunnel Token。

然后运行：

```bash
export DASHOU_TRUST_PROXY=1
dashou serve
```

通过 Cloudflare Tunnel 或其他反向代理对外提供 HTTPS 时必须设置
`DASHOU_TRUST_PROXY=1`，让限流器正确识别代理转发的客户端地址。Dashou 仍只监听本机
`127.0.0.1`；不要在没有反向代理的情况下把这个变量用于公网监听。

如果配置了 Tunnel Token，搭手会同时启动 `cloudflared`。如果未配置 token，则认为公网 Tunnel 由用户自己维护。

同一个 `DASHOU_STATE_DIR` 只允许一个 `dashou serve` 实例；重复启动会明确失败。若 `doctor --json`
报告运行时不匹配，先按报告修正 Node/npm/npx，再启动服务。服务关闭时会先停止接收新请求，等待已在途
请求结束后再关闭 OAuth/MCP 状态，便于升级和重启。

## ChatGPT 连接

MCP URL 为：

```text
https://xxx.warmbyte.studio/mcp
```

首次连接会打开搭手授权页。用户输入 `dashou init` 生成的连接密码完成 OAuth 授权。

连接后模型只能看到五个工具：

```text
open_project
read
write
edit
execute
```

如果出现 Task、Review、Lease、Subagent、Skill 等工具，视为 V0 配置错误。

自动化 smoke 只能证明 Dashou 与兼容 MCP 客户端的协议闭环；它不能替代 ChatGPT
真实界面的连接、OAuth、工具调用和用户体验验收。真实验收需要可用的 ChatGPT
Business/Enterprise/Edu 或当前允许连接自定义 MCP 的开发模式账号。

也可以对一次性测试目录运行 OpenAI Responses API smoke（需要公网 `/mcp` 和用户自己提供的
`OPENAI_API_KEY`）：

```bash
export DASHOU_MCP_URL=https://xxx.warmbyte.studio/mcp
export DASHOU_MCP_OWNER_TOKEN='dashou init 输出的连接密码'
export DASHOU_OPENAI_PROJECT_PATH=/absolute/path/to/disposable-project
export OPENAI_API_KEY='由用户自己注入，不要写入聊天或日志'
npm run verify:openai
```

它会验证 `mcp_list_tools` 只有五个工具并发送真实模型消息；写入、修改、执行默认需要 approval。
明确审核过一次性目录后才设置 `OPENAI_MCP_AUTO_APPROVE_MUTATIONS=1`。该证据属于 OpenAI
Responses API，不冒充 ChatGPT 网页或桌面 UI 验收。

## 第一次体验任务

不要让用户做专门设计的 Demo。让他选择一个今天本来就要完成的真实工作，例如：

- 修改一份 Markdown / 文本资料。
- 批量整理一个小项目中的文件。
- 修一个真实代码问题并运行测试。
- 查找项目内容并生成或修改一个文件。

建议只给一句引导：

> 直接告诉 ChatGPT 你今天希望它在这个目录里完成什么。

## 需要记录的信号

第一周只看这些：

- 是否完成安装。
- 是否完成第一次真实文件读写或命令执行。
- 从安装到第一次有效结果用了多久。
- 第二天是否主动再次使用。
- 七天内使用了几天。
- 完成了多少个真实任务。
- 如果没有搭手，本来会怎么做。
- 最让用户不放心或最麻烦的一步是什么。
- 试用结束后是否愿意真实付一次钱。

不要以 MCP 调用次数作为产品价值指标。

## 当前不验证

本轮明确不加入：

- Task / 多 Agent 协作
- 长期 Memory
- Cloud Workspace
- Review / Approval 工作流
- Skill / Harness
- 企业治理

只有用户自然出现“换 Agent 后接不上”“不知道上次做到哪里”“为什么又问我同样的事情”时，再把这些需求升级为下一阶段实验。
