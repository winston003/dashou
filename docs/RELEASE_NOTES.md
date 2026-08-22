# 0.1.3-rc.16

- 新增工作区 Harness：进入项目时按目录层级读取 `AGENTS.override.md`、`AGENTS.md` 和 `CLAUDE.md`，让 ChatGPT 在读写和执行前遵守项目守则。
- 项目守则超过安全上限或上下文版本尚未确认时，写入、编辑和执行会停止，不会在规则不完整时继续操作。
- 修复身份恢复时随机生成新设备标识的问题；升级和受控恢复会保留 installation、device 与已有申请之间的绑定。
- Harness 审计日志只记录操作边界和结果，不记录文件内容或命令正文。
- 修复启动 Runtime 时继承交互式 Bash 配置的问题，避免本机 shell 工具覆盖随包 Node.js。
