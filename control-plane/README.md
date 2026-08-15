# Dashou pilot control plane

Cloudflare Worker + D1 控制面负责设备申请、管理员审核、授权周期、独立 Tunnel/DNS、短期 signed lease 与撤销。正常用户流程不再需要管理员生成邀请文件。

## 用户与管理员流程

```text
用户安装桌面端 → 点击申请开通 → 管理员 CLI 审核
→ Worker 为该设备准备独立 Tunnel 和子域名
→ 桌面端自动领取并保存配置 → 用户连接 ChatGPT
```

连接密码只在桌面端本地生成，Worker 不接收、不保存。设备申请凭据和试用账号 token 在 D1 中只存 SHA-256；待领取的 Tunnel/试用凭据使用 AES-256-GCM 暂存，桌面端保存成功后会确认清除。

## 首次部署

先确认 Cloudflare 身份与目标账号：

```bash
npx wrangler whoami
npx wrangler d1 migrations apply dashou-pilot-control --remote --config control-plane/wrangler.jsonc
```

配置 Worker secrets：

```bash
npx wrangler secret put PILOT_ADMIN_TOKEN --config control-plane/wrangler.jsonc
npx wrangler secret put PILOT_LEASE_PRIVATE_KEY --config control-plane/wrangler.jsonc
npx wrangler secret put PILOT_LEASE_PUBLIC_KEY --config control-plane/wrangler.jsonc
npx wrangler secret put DASHOU_ACTIVATION_KEY --config control-plane/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_API_TOKEN --config control-plane/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID --config control-plane/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_ZONE_ID --config control-plane/wrangler.jsonc
npx wrangler secret put DASHOU_PUBLIC_DOMAIN --config control-plane/wrangler.jsonc
```

`DASHOU_ACTIVATION_KEY` 是 base64url 编码的 32 字节随机值。可在管理员本机生成后直接送入 Wrangler，不要写入仓库或聊天：

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Cloudflare API Token 只授予目标账号的 `Cloudflare Tunnel Write` 和目标 zone 的 `DNS Write`。任何拿到设备 Tunnel Token 的人都能运行该 Tunnel，因此 Worker 只向对应设备的高熵申请凭据返回它，并在设备确认后清除暂存密文。

部署前验证：

```bash
npm run verify:control-plane
```

真实部署使用仓库脚本；脚本拒绝脏工作树，并把当前提交 SHA 写入健康检查：

```bash
npm run deploy:control-plane
```

## 管理员审核

管理员只需在自己的终端配置控制面地址和管理员 token：

```bash
export DASHOU_PILOT_CONTROL_URL='https://dashou-pilot-control.whilewon.workers.dev'
export DASHOU_PILOT_CONTROL_ADMIN_TOKEN='只在管理员终端注入'
```

日常命令：

```bash
dashou admin applications list
dashou admin applications approve req_xxx --period week
dashou admin applications approve req_xxx --period month
dashou admin applications approve req_xxx --period quarter
dashou admin applications approve req_xxx --period year
dashou admin applications reject req_xxx --reason '请联系客服核对设备'
dashou admin applications revoke req_xxx
```

周/月/季/年目前是授权周期，不代表已经发生真实付款。真实计费接入支付提供商后再改变状态来源，设备申请与审批协议无需重做。

## API 边界

设备接口：

- `POST /applications`
- `GET /applications/:id`
- `POST /applications/:id/activate`
- `POST /applications/:id/activate/confirm`

管理员接口：

- `GET /admin/applications?status=pending`
- `POST /admin/applications/:id/approve`
- `POST /admin/applications/:id/reject`
- `POST /admin/applications/:id/revoke`

兼容账号接口仍保留在 `/admin/pilot/accounts`。所有管理员接口只接受 `PILOT_ADMIN_TOKEN` Bearer 凭据。日志不得记录管理员 token、申请凭据、Pilot token、Tunnel Token 或激活密文。

部署上线不等于用户验收。上线后仍要分别验证 D1 migration、Worker `/healthz`、真实 Tunnel/DNS、外部 HTTPS、桌面领取、ChatGPT OAuth 和第一个真实本地任务。
