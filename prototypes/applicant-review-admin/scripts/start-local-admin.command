#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/whilewon/workspace/dashou/prototypes/applicant-review-admin"
ADMIN_URL="http://127.0.0.1:4173/"

if [[ ! -d "$PROJECT_DIR" ]]; then
  print -u2 "找不到申请审核面板目录：$PROJECT_DIR"
  exit 1
fi

cd "$PROJECT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  print -u2 "找不到 npm，请先安装 Node.js。"
  exit 1
fi

if curl --noproxy '*' --silent --show-error --fail --max-time 2 "$ADMIN_URL" >/dev/null 2>&1; then
  print "申请审核面板已经在运行，正在打开 $ADMIN_URL"
  open "$ADMIN_URL"
  exit 0
fi

if [[ ! -d node_modules ]]; then
  print "首次运行：正在安装面板依赖……"
  npm install
fi

print "正在启动本机申请审核面板：$ADMIN_URL"
print "关闭此窗口会停止本次本机面板进程。"
npm run dev -- --host 127.0.0.1 --port 4173 &
LOCAL_SERVER_PID=$!
trap 'kill "$LOCAL_SERVER_PID" 2>/dev/null || true' EXIT INT TERM

for _ in {1..40}; do
  if curl --noproxy '*' --silent --show-error --fail --max-time 1 "$ADMIN_URL" >/dev/null 2>&1; then
    open "$ADMIN_URL" 2>/dev/null || true
    break
  fi
  sleep 0.25
done

wait "$LOCAL_SERVER_PID"
