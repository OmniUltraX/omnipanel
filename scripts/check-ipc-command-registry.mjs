/**
 * 校验 src-tauri/src/lib.rs 中 collect_commands! 与 generate_handler! 的命令集合。
 *
 * 规则：
 * 1. collect 有、handler 无 → 一律失败（类型导出了却跑不通）。
 * 2. handler 有、collect 无 → 必须在下方白名单中（Channel 流、窗口/调试、尚未 specta 的协议命令等）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libPath = path.join(root, "src-tauri/src/lib.rs");
const source = fs.readFileSync(libPath, "utf8");

/** 有意不进 specta 导出的运行时命令（逐步消化，勿随意新增）。 */
const HANDLER_ONLY_ALLOWLIST = new Set([
  // Channel 流式；注释见 lib.rs collect_commands
  "ai_chat::ai_chat_stream",
  // 调试 / 日志旁路
  "debug::debug_open_devtools",
  "log::clear_backend_logs",
  "log::get_backend_logs",
  // Protocol Lab（尚未挂 specta）
  "protocol::http_request",
  "protocol::mqtt_connect",
  "protocol::mqtt_disconnect",
  "protocol::mqtt_publish",
  "protocol::mqtt_subscribe",
  "protocol::mqtt_unsubscribe",
  "protocol::redis_pubsub_connect",
  "protocol::redis_pubsub_disconnect",
  "protocol::redis_pubsub_publish",
  "protocol::redis_pubsub_subscribe",
  "protocol::redis_pubsub_unsubscribe",
  "protocol::serial_close",
  "protocol::serial_open",
  "protocol::serial_scan_ports",
  "protocol::serial_set_dtr",
  "protocol::serial_set_rts",
  "protocol::serial_write",
  "protocol::ws_close",
  "protocol::ws_connect",
  "protocol::ws_ping",
  "protocol::ws_send_binary",
  "protocol::ws_send_text",
  // 工作区多窗口（窗口插件侧）
  "workspace_window::cleanup_expired_handoffs",
  "workspace_window::clear_workspace_window_handoff",
  "workspace_window::close_all_workspace_windows",
  "workspace_window::open_workspace_window",
  "workspace_window::read_workspace_window_handoff",
  "workspace_window::window_label_at_screen_point",
  "workspace_window::window_z_order",
  "workspace_window::workspace_window_debug_log",
  "workspace_window::workspace_window_debug_log_path",
  "workspace_window::workspace_window_debug_log_read",
  "workspace_window::write_workspace_window_handoff",
]);

function extractMacroBody(src, macroName) {
  const needle = `${macroName}![`;
  const start = src.indexOf(needle);
  if (start < 0) {
    throw new Error(`未找到 ${macroName}!`);
  }
  let i = start + needle.length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    i += 1;
  }
  if (depth !== 0) {
    throw new Error(`${macroName}! 括号未闭合`);
  }
  return src.slice(start + needle.length, i - 1);
}

function parseCommands(body) {
  const set = new Set();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/((?:commands::)?[a-zA-Z0-9_:]+)\s*,?\s*$/);
    if (!m) continue;
    let name = m[1].replace(/,$/, "");
    if (!/::/.test(name)) continue;
    set.add(name.replace(/^commands::/, ""));
  }
  return set;
}

const collect = parseCommands(extractMacroBody(source, "collect_commands"));
const handler = parseCommands(extractMacroBody(source, "generate_handler"));

const onlyCollect = [...collect].filter((c) => !handler.has(c)).sort();
const onlyHandler = [...handler].filter((c) => !collect.has(c)).sort();
const unexpectedHandlerOnly = onlyHandler.filter((c) => !HANDLER_ONLY_ALLOWLIST.has(c));
const staleAllowlist = [...HANDLER_ONLY_ALLOWLIST].filter((c) => !onlyHandler.includes(c)).sort();

console.log(`collect_commands: ${collect.size}`);
console.log(`generate_handler: ${handler.size}`);
console.log(`handler-only（白名单内）: ${onlyHandler.length - unexpectedHandlerOnly.length}`);

let failed = false;

if (onlyCollect.length) {
  failed = true;
  console.error("\n仅在 collect_commands（有类型、无运行时）— 必须补进 generate_handler:");
  for (const c of onlyCollect) console.error(`  - ${c}`);
}

if (unexpectedHandlerOnly.length) {
  failed = true;
  console.error("\n仅在 generate_handler 且不在白名单 — 请补进 collect_commands，或更新白名单:");
  for (const c of unexpectedHandlerOnly) console.error(`  - ${c}`);
}

if (staleAllowlist.length) {
  failed = true;
  console.error("\n白名单陈旧（已不在 handler-only）— 请从脚本中删除:");
  for (const c of staleAllowlist) console.error(`  - ${c}`);
}

if (failed) {
  console.error("\n::error::IPC 双清单校验失败");
  process.exit(1);
}

console.log("IPC 双清单校验通过 ✓");
