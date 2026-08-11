#!/bin/sh
# OmniPanel Web 容器入口：数据目录、API Key 运行时注入、安全警告。
set -e

export HOME="${OMNIPANEL_DATA_DIR:-/data}"
mkdir -p "$HOME"

PORT="${OMNIPANEL_PORT:-8899}"
BIND="${OMNIPANEL_BIND:-0.0.0.0}"
STATIC_DIR="${OMNIPANEL_STATIC_DIR:-/app/static}"

if [ -z "${OMNIPANEL_API_KEY:-}" ]; then
  echo "================================================================"
  echo "[WARN] OMNIPANEL_API_KEY 未设置"
  echo "       任何能访问本服务端口的人均可操作终端 / SSH / Docker"
  echo "       仅限本地试用；生产环境请务必设置 API Key，例如："
  echo "         -e OMNIPANEL_API_KEY=your-long-random-secret"
  echo "================================================================"
else
  # 浏览器 IPC 在运行时读取（见 frontend/src/ipc/transport.ts）
  KEY_ESC=$(printf '%s' "$OMNIPANEL_API_KEY" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
  printf 'window.__OMNIPANEL_API_KEY__="%s";\n' "$KEY_ESC" > "${STATIC_DIR}/omnipanel-runtime-config.js"
fi

if [ -S /var/run/docker.sock ]; then
  echo "[INFO] 已检测到 /var/run/docker.sock — 将管理宿主机 Docker Engine"
fi

echo "[INFO] OmniPanel Web 数据目录: ${HOME}/.omnipd"
echo "[INFO] 监听 ${BIND}:${PORT}"

if [ -n "${OMNIPANEL_API_KEY:-}" ]; then
  exec omnipanel-server \
    --bind "$BIND" \
    --port "$PORT" \
    --static-dir "$STATIC_DIR" \
    --api-key "$OMNIPANEL_API_KEY"
fi

exec omnipanel-server \
  --bind "$BIND" \
  --port "$PORT" \
  --static-dir "$STATIC_DIR"
