# Dashou pilot control plane

这是首批内测用的最小 Cloudflare Worker + D1 控制面。它只负责账号试用开关和短期 signed lease：创建账号、发放一次性账号 token、启用/禁用、修改到期时间和撤销。

## 部署

```bash
npx wrangler d1 create dashou-pilot-control
# 将命令输出的 database_id 写入 wrangler.jsonc
npx wrangler d1 migrations apply dashou-pilot-control --remote
npx wrangler secret put PILOT_ADMIN_TOKEN
npx wrangler secret put PILOT_LEASE_PRIVATE_KEY
npx wrangler deploy
```

`PILOT_ADMIN_TOKEN` 只通过 Wrangler secret 注入。数据库只存用户 token 的 SHA-256 hash，创建接口返回的明文 token 只显示一次。

部署前先执行：

```bash
npx wrangler deploy --dry-run
```

然后用管理员 token 调用 `POST /admin/pilot/accounts` 创建账号。把响应里的 `token` 配置到 Dashou 客户端的 `DASHOU_PILOT_POLICY_TOKEN`，把 Worker 的 RSA 公钥配置到 `DASHOU_PILOT_POLICY_PUBLIC_KEY`，并把 `/pilot-policy` 配置到 `DASHOU_PILOT_POLICY_URL`。Worker 返回的 lease 使用 RSA-PSS/SHA-256 签名，默认有效期最多 15 分钟；账号更早到期时取账号到期时间。

仓库根目录还提供简单管理命令：

```bash
export DASHOU_PILOT_CONTROL_URL=https://dashou-pilot-control.whilewon.workers.dev
export DASHOU_PILOT_CONTROL_ADMIN_TOKEN='只在管理员终端注入'
npm run pilot:admin -- create pilot-alice 2026-09-01T00:00:00.000Z
npm run pilot:admin -- disable pilot-alice
npm run pilot:admin -- enable pilot-alice
npm run pilot:admin -- revoke pilot-alice
```

`create` 响应中的用户 token 只显示一次；不要写入 Git、聊天或共享日志。

这不是完整的生产账号平台：没有登录页、计费、租户隔离、审计后台或 Tunnel 自动发放。公网部署前仍需单独完成 Cloudflare 认证、域名/SNI、HTTPS、速率限制和日志策略审查。
