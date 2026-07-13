#!/usr/bin/env node
/**
 * 生成 frontend/src/ipc/bindings.ts（tauri-specta）。
 * 需在 debug 配置下运行：export_ipc_bindings 仅 #[cfg(debug_assertions)] 启用。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(repoRoot, "src-tauri");
const bindingsPath = path.join(repoRoot, "frontend", "src", "ipc", "bindings.ts");

const result = spawnSync("cargo", ["check"], {
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

console.log(`IPC bindings 已生成: ${bindingsPath}`);
