#!/usr/bin/env node
/**
 * frontend `prebuild` 钩子：本地在构建前刷新 IPC bindings。
 * CI / 显式 SKIP_GEN_BINDINGS=1 时跳过（使用仓库内已提交的 bindings.ts），
 * 避免 Windows 上 `cargo run` debug 二进制在导出类型时栈溢出。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skip =
  process.env.CI === "true" ||
  process.env.SKIP_GEN_BINDINGS === "1" ||
  process.env.SKIP_GEN_BINDINGS === "true";

if (skip) {
  console.log("[prebuild] 跳过 gen:bindings（CI 或 SKIP_GEN_BINDINGS）");
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("npm", ["run", "gen:bindings"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

process.exit(result.status ?? 1);
