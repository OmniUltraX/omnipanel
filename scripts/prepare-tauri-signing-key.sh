#!/usr/bin/env bash
# 从 GitHub Secret 准备 Tauri 签名私钥文件（兼容 Linux / macOS / Git Bash）
# 环境变量:
#   RAW_KEY      - UPDATER_PRIVATE_KEY secret 全文
#   KEY_PASSWORD - UPDATER_PRIVATE_KEY_PASSWORD（可为空）
# 输出:
#   写入 GITHUB_ENV: TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD

set -euo pipefail

encode_base64_nowrap() {
  if base64 --help 2>&1 | grep -qE '(^|[[:space:]])-w([,[:space:]]|$)'; then
    base64 -w0
  else
    base64 | tr -d '\n'
  fi
}

decode_base64_file() {
  local file="$1"
  local decoded=""

  if decoded="$(base64 -d <"$file" 2>/dev/null)" && [[ -n "$decoded" ]]; then
    printf '%s' "$decoded"
    return 0
  fi
  if decoded="$(base64 --decode <"$file" 2>/dev/null)" && [[ -n "$decoded" ]]; then
    printf '%s' "$decoded"
    return 0
  fi
  if decoded="$(base64 -D -i "$file" 2>/dev/null)" && [[ -n "$decoded" ]]; then
    printf '%s' "$decoded"
    return 0
  fi
  if decoded="$(base64 -D <"$file" 2>/dev/null)" && [[ -n "$decoded" ]]; then
    printf '%s' "$decoded"
    return 0
  fi
  return 1
}

if [[ -z "${RAW_KEY:-}" ]]; then
  echo "::error::GitHub Secret UPDATER_PRIVATE_KEY 未配置。"
  echo "请执行: cd frontend && npm run tauri -- signer generate -w tauri-signing.key --ci -p \"\""
  echo "将 tauri-signing.key 文件全文（单行 base64）粘贴到 Secret。"
  exit 1
fi

KEY_FILE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tauri-signing.key"
trimmed="$(printf '%s' "$RAW_KEY" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

if printf '%s' "$trimmed" | grep -q 'untrusted comment:'; then
  printf '%s' "$RAW_KEY" | encode_base64_nowrap >"$KEY_FILE"
  echo "已将 minisign 明文密钥转换为 base64"
else
  printf '%s' "$trimmed" >"$KEY_FILE"
fi

if ! decoded="$(decode_base64_file "$KEY_FILE")" || [[ -z "$decoded" ]]; then
  echo "::error::UPDATER_PRIVATE_KEY 不是有效 base64。"
  echo "请直接粘贴 tauri-signing.key 文件全文，不要手动解码或添加空格/换行。"
  exit 1
fi

chmod 600 "$KEY_FILE"
echo "TAURI_SIGNING_PRIVATE_KEY=$KEY_FILE" >>"${GITHUB_ENV:?GITHUB_ENV is required}"
echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${KEY_PASSWORD:-}" >>"$GITHUB_ENV"
echo "签名密钥已就绪（解码后 ${#decoded} 字节）"
