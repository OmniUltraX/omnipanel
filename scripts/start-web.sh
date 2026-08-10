#!/usr/bin/env bash
# =============================================================
# OmniPanel 云原生开发：构建并启动 Web 版前后端
#
# 被 .cnb.yml 的 vscode.options.launch 调用（仅预览模式）。
# 效果等价于本地：
#   cd frontend && OMNIPANEL_WEB=1 npm run build && cd ..
#   cargo build --release -p omnipanel-server
#   ./target/release/omnipanel-server --bind 0.0.0.0:8686 --static-dir frontend/dist
#
# 正常流程：.cnb.yml 的 stages 阶段已在完整源码工作区完成前后端构建，
# 本脚本检测到产物后跳过构建、秒级启动服务，确保 8686 端口在检测窗口内就绪。
# 若产物缺失（如镜像未预编译/环境重建），则在此兜底构建后启动。
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
# 正常情况下 stages 阶段已构建（见 .cnb.yml），产物存在时跳过，秒级启动。
if [ -d frontend/dist ] && [ -f frontend/dist/index.html ]; then
  log "前端产物已存在（stages 已构建），跳过前端构建。"
else
  log "前端产物缺失，兜底构建前端（Web 模式，OMNIPANEL_WEB=1）..."
  if [ ! -d frontend/node_modules ]; then
    log "安装前端依赖..."
    npm ci --prefix frontend || npm install --prefix frontend
  fi
  # CI 跳过 IPC bindings 重新生成，直接用仓库已提交的 bindings.ts
  SKIP_GEN_BINDINGS=1 OMNIPANEL_WEB=1 npm run build --prefix frontend \
    || fail "前端构建失败，请查看上方日志"
fi

# ---------- 2. 后端：构建 omnipanel-server ----------
BIN="$ROOT_DIR/target/release/omnipanel-server"
# 正常情况下 stages 阶段已构建（见 .cnb.yml），产物存在时跳过，秒级启动。
if [ -x "$BIN" ]; then
  log "后端产物已存在（stages 已构建），跳过后端构建。"
else
  log "后端产物缺失，兜底构建 omnipanel-server（release）..."
  cargo build --release -p omnipanel-server || fail "后端构建失败，请查看上方日志"
fi

[ -x "$BIN" ] || fail "后端二进制未生成: $BIN"

# ---------- 3. 启动 Web 服务 ----------
log "启动 OmniPanel Web 服务 → 0.0.0.0:${PORT}（静态托管 frontend/dist）..."
exec "$BIN" \
  --bind "0.0.0.0" \
  --port "$PORT" \
  --static-dir "$ROOT_DIR/frontend/dist"
