#!/bin/sh
set -eu
export HOME="${OMNIPANEL_DATA_DIR:-/data}"
mkdir -p "$HOME"
PORT="${OMNIPANEL_PORT:-8899}"
BIND="${OMNIPANEL_BIND:-0.0.0.0}"
STATIC_DIR="${OMNIPANEL_STATIC_DIR:-/app/static}"
# Remove legacy generated credentials even when reusing a custom static bind mount.
rm -f "${STATIC_DIR}/omnipanel-runtime-config.js"
KEY_PRESENT=$(printf '%s' "${OMNIPANEL_API_KEY:-}" | tr -d '[:space:]')
if [ -z "$KEY_PRESENT" ] && [ "${OMNIPANEL_ALLOW_UNAUTHENTICATED:-0}" != "1" ]; then
  echo "[ERROR] Set OMNIPANEL_API_KEY; the Web image refuses unauthenticated startup." >&2
  exit 1
fi
if [ -z "$KEY_PRESENT" ]; then
  echo "[WARN] Explicit unauthenticated development mode. Never expose this port." >&2
fi
echo "[INFO] OmniPanel Web listening on ${BIND}:${PORT}; data: ${HOME}/.omnipd"
# Server reads OMNIPANEL_API_KEY from environment, never command-line arguments/static JS.
exec omnipanel-server --bind "$BIND" --port "$PORT" --static-dir "$STATIC_DIR"
