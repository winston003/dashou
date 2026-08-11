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

安装：

```bash
npm install -g @warmbyte/dashou
dashou init
```

初始化只需要回答四件事：

1. ChatGPT 可以访问哪个本地目录。
2. 本地端口，默认 `7677`。
3. 管理员分配的 `https://xxx.warmbyte.studio`。
4. 管理员分配的 Tunnel Token。

然后运行：

```bash
dashou serve
```

如果配置了 Tunnel Token，搭手会同时启动 `cloudflared`。如果未配置 token，则认为公网 Tunnel 由用户自己维护。

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
