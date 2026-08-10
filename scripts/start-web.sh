#!/usr/bin/env bash
# =============================================================
# OmniPanel 云原生开发：自动构建并启动 Web 版前后端
#
# 被 .cnb.yml 的 vscode.options.launch 调用（仅预览模式）。
# 效果等价于本地：
#   cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..
#   cargo build --release -p omnipanel-server
#   ./target/release/omnipanel-server --bind 0.0.0.0:8686 --static-dir frontend/dist
#
# 业务端口固定 8686（仅预览模式必须，见 docs 业务端口预览），且必须绑 0.0.0.0 才能被端口预览访问。
# =============================================================
set -euo pipefail

# 项目根目录（兼容从任意 cwd 调用）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PORT="${OMNIPANEL_WEB_PORT:-8686}"

log() { echo "[start-web] $*"; }
fail() { echo "[start-web] ERROR: $*" >&2; exit 1; }

command -v cargo >/dev/null 2>&1 || fail "未找到 cargo（Rust 工具链缺失，请检查 .ide/Dockerfile）"
command -v node  >/dev/null 2>&1 || fail "未找到 node（Node.js 缺失，请检查 .ide/Dockerfile）"

# 若旧进程仍在监听，先停掉（仅预览模式重复进入场景）
if command -v fuser >/dev/null 2>&1 && fuser -k "$PORT/tcp" >/dev/null 2>&1; then
  log "已释放端口 $PORT 上的旧进程"
  sleep 1
fi

# ---------- 1. 前端：Web 模式构建（生成 frontend/dist） ----------
log "构建前端（Web 模式，OMNIPANEL_WEB=1）..."
if [ ! -d frontend/node_modules ]; then
  log "安装前端依赖..."
  npm ci --prefix frontend || npm install --prefix frontend
fi
# CI 跳过 IPC bindings 重新生成，直接用仓库已提交的 bindings.ts
SKIP_GEN_BINDINGS=1 OMNIPANEL_WEB=1 npm run build --prefix frontend \
  || fail "前端构建失败，请查看上方日志"

# ---------- 2. 后端：构建 omnipanel-server ----------
log "构建后端 omnipanel-server（release）..."
cargo build --release -p omnipanel-server || fail "后端构建失败，请查看上方日志"

BIN="$ROOT_DIR/target/release/omnipanel-server"
[ -x "$BIN" ] || fail "后端二进制未生成: $BIN"

# ---------- 3. 启动 Web 服务 ----------
log "启动 OmniPanel Web 服务 → 0.0.0.0:${PORT}（静态托管 frontend/dist）..."
exec "$BIN" \
  --bind "0.0.0.0" \
  --port "$PORT" \
  --static-dir "$ROOT_DIR/frontend/dist"
