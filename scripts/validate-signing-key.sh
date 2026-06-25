#!/usr/bin/env bash
# 本地 / CI 快速验证 Tauri 更新签名密钥（逻辑与 build.yml Prepare 步骤一致）
# 用法:
#   bash scripts/validate-signing-key.sh
#   bash scripts/validate-signing-key.sh --key frontend/tauri-signing.key
#   bash scripts/validate-signing-key.sh --secret /path/to/gh-secret.txt

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
TAURI_CONF="$REPO_ROOT/src-tauri/tauri.conf.json"
DEFAULT_KEY="$FRONTEND_DIR/tauri-signing.key"

KEY_PATH=""
SECRET_FILE=""
PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

usage() {
  cat <<'EOF'
用法: bash scripts/validate-signing-key.sh [选项]

选项:
  --key <path>       私钥文件路径（默认 frontend/tauri-signing.key）
  --secret <path>    模拟 GitHub Secret UPDATER_PRIVATE_KEY 的内容文件
  --password <pwd>   私钥密码（无密码密钥请传空字符串: --password ""）
  -h, --help         显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)
      KEY_PATH="$2"
      shift 2
      ;;
    --secret)
      SECRET_FILE="$2"
      shift 2
      ;;
    --password)
      PASSWORD="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

step() { echo ""; echo ">> $1"; }
ok() { echo "OK  $1"; }
fail() { echo "FAIL $1" >&2; }

cleanup() {
  [[ -n "${TEMP_KEY_FILE:-}" && -f "$TEMP_KEY_FILE" ]] && rm -f "$TEMP_KEY_FILE"
  [[ -n "${PROBE_FILE:-}" && -f "$PROBE_FILE" ]] && rm -f "$PROBE_FILE" "${PROBE_FILE}.sig"
}
trap cleanup EXIT

validate_base64_file() {
  local file="$1"
  local decoded=""
  if ! decoded="$(decode_base64_file "$file")" || [[ -z "$decoded" ]]; then
    fail "不是有效的 base64（请粘贴 tauri-signing.key 全文，勿手动解码）"
    exit 1
  fi
  ok "base64 有效（解码后 ${#decoded} 字节）"
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

encode_base64_nowrap() {
  if base64 --help 2>&1 | grep -qE '(^|[[:space:]])-w([,[:space:]]|$)'; then
    base64 -w0
  else
    base64 | tr -d '\n'
  fi
}

prepare_key_from_secret() {
  local secret_path="$1"
  local out_path="$2"
  local raw trimmed

  if [[ ! -f "$secret_path" ]]; then
    fail "Secret 文件不存在: $secret_path"
    exit 1
  fi

  raw="$(cat "$secret_path")"
  if [[ -z "$raw" ]]; then
    fail "Secret 文件为空"
    exit 1
  fi

  trimmed="$(printf '%s' "$raw" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if printf '%s' "$trimmed" | grep -q 'untrusted comment:'; then
    echo "    检测到 minisign 明文，转换为 base64 单行格式..."
    printf '%s' "$raw" | encode_base64_nowrap >"$out_path"
  else
    printf '%s' "$trimmed" >"$out_path"
  fi

  validate_base64_file "$out_path"
}

check_pubkey() {
  local key_file="$1"
  local pub_path="${key_file%.key}.pub"
  local conf_pub file_pub

  if [[ ! -f "$TAURI_CONF" ]]; then
    echo "    跳过：未找到 tauri.conf.json"
    return 0
  fi

  conf_pub="$(node -e "
    const fs = require('fs');
    const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf8'));
    const pub = conf?.plugins?.updater?.pubkey;
    if (!pub) process.exit(2);
    process.stdout.write(pub.trim());
  " 2>/dev/null || true)"

  if [[ -z "$conf_pub" ]]; then
    echo "    跳过：tauri.conf.json 未配置 updater.pubkey"
    return 0
  fi

  if [[ ! -f "$pub_path" && -f "$DEFAULT_KEY.pub" ]]; then
    pub_path="$DEFAULT_KEY.pub"
  fi

  if [[ ! -f "$pub_path" ]]; then
    echo "    跳过：未找到 $pub_path"
    return 0
  fi

  file_pub="$(tr -d '\r\n' <"$pub_path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ "$file_pub" == "$conf_pub" ]]; then
    ok "pubkey 与 tauri.conf.json 一致"
  else
    fail "pubkey 与 tauri.conf.json 不一致，请更新 plugins.updater.pubkey"
    exit 1
  fi
}

echo "OmniPanel Tauri 签名密钥验证"

step "1/3 准备私钥文件"
TEMP_KEY_FILE=""
RESOLVED_KEY=""

if [[ -n "$SECRET_FILE" ]]; then
  TEMP_KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/omnipanel-signing-key.XXXXXX")"
  prepare_key_from_secret "$SECRET_FILE" "$TEMP_KEY_FILE"
  RESOLVED_KEY="$TEMP_KEY_FILE"
  ok "已从 Secret 文件生成临时密钥"
elif [[ -n "$KEY_PATH" ]]; then
  if [[ ! -f "$KEY_PATH" ]]; then
    fail "私钥文件不存在: $KEY_PATH"
    exit 1
  fi
  RESOLVED_KEY="$KEY_PATH"
  validate_base64_file "$RESOLVED_KEY"
  ok "私钥文件: $RESOLVED_KEY"
elif [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$TAURI_SIGNING_PRIVATE_KEY" ]]; then
  RESOLVED_KEY="$TAURI_SIGNING_PRIVATE_KEY"
  validate_base64_file "$RESOLVED_KEY"
  ok "使用环境变量 TAURI_SIGNING_PRIVATE_KEY"
elif [[ -f "$DEFAULT_KEY" ]]; then
  RESOLVED_KEY="$DEFAULT_KEY"
  validate_base64_file "$RESOLVED_KEY"
  ok "使用默认私钥: $DEFAULT_KEY"
else
  fail "未找到私钥。请先生成: cd frontend && npm run tauri -- signer generate -w tauri-signing.key --ci -p \"\""
  exit 1
fi

step "2/3 校验 pubkey 配置"
check_pubkey "$RESOLVED_KEY"

step "3/3 Trial sign"
unset TAURI_SIGNING_PRIVATE_KEY 2>/dev/null || true
export TAURI_SIGNING_PRIVATE_KEY_PATH="$RESOLVED_KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PASSWORD"

PROBE_FILE="$(mktemp "${TMPDIR:-/tmp}/omnipanel-sign-probe.XXXXXX.txt")"
printf 'omnipanel-signing-probe' >"$PROBE_FILE"

(
  cd "$FRONTEND_DIR"
  npm run tauri -- signer sign -f "$RESOLVED_KEY" "$PROBE_FILE"
)

if [[ ! -f "${PROBE_FILE}.sig" ]]; then
  fail "未生成签名文件: ${PROBE_FILE}.sig"
  exit 1
fi

ok "试签名成功，已生成 ${PROBE_FILE}.sig"

echo ""
echo "全部通过。GitHub Secrets 可按此配置:"
echo "  UPDATER_PRIVATE_KEY          = tauri-signing.key 全文（单行 base64）"
echo "  UPDATER_PRIVATE_KEY_PASSWORD = 留空（无密码密钥）或你的实际密码"
echo ""
