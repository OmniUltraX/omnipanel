#!/usr/bin/env bash
# Headless process smoke only, not a replacement for interactive GUI acceptance.
set -euo pipefail
ulimit -c 0
binary=$(realpath "${1:?Usage: bash scripts/smoke-linux-startup.sh <app-binary>}")
root=$(mktemp -d)
mkdir -p "$root"/{home,config,data,cache}
log=${OMNIPANEL_SMOKE_LOG:-"$root/startup.log"}
set +e
xvfb-run -a dbus-run-session -- env -u USERPROFILE \
  HOME="$root/home" XDG_CONFIG_HOME="$root/config" \
  XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" \
  NO_AT_BRIDGE=1 GDK_BACKEND=x11 \
  timeout --signal=TERM --kill-after=5s 30s "$binary" > "$log" 2>&1
code=$?
set -e
if [ "$code" -ne 124 ]; then
  cat "$log"
  echo "Linux startup failed before the 30s timeout (exit $code)" >&2
  exit 1
fi
python3 - "$log" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text(errors="replace")
assert "panicked at" not in text and "thread caused non-unwinding panic" not in text, text
PY
printf 'Linux process stayed alive for 30s without a Rust panic. Log: %s\n' "$log"
