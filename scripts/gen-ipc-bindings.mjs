#!/usr/bin/env node
/**
 * 生成 frontend/src/ipc/bindings.ts（tauri-specta）。
 * 需在 debug 配置下运行：export_ipc_bindings 仅 #[cfg(debug_assertions)] 启用。
 * 必须 `cargo run`（不是 check）：导出发生在 `omnipanel_lib::run()` 入口。
 *
 * CI / SKIP_GEN_BINDINGS=1 时直接跳过（使用仓库内已提交的 bindings.ts）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skip =
  process.env.CI === "true" ||
  process.env.SKIP_GEN_BINDINGS === "1" ||
  process.env.SKIP_GEN_BINDINGS === "true";

if (skip) {
  console.log("[gen:bindings] 跳过（CI 或 SKIP_GEN_BINDINGS），使用已提交的 bindings.ts");
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(repoRoot, "src-tauri");
const bindingsPath = path.join(repoRoot, "frontend", "src", "ipc", "bindings.ts");

const beforeMtime = existsSync(bindingsPath) ? statSync(bindingsPath).mtimeMs : 0;

const result = spawnSync("cargo", ["run"], {
  cwd: tauriDir,
  env: { ...process.env, OMNIPANEL_GEN_BINDINGS_ONLY: "1" },
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(bindingsPath)) {
  console.error(`::error::未生成 bindings 文件: ${bindingsPath}`);
  process.exit(1);
}

const afterMtime = statSync(bindingsPath).mtimeMs;
if (afterMtime <= beforeMtime) {
  console.error("::error::bindings.ts 未更新（export_ipc_bindings 可能未执行）");
  process.exit(1);
}

console.log(`IPC bindings 已生成: ${bindingsPath}`);
