#!/usr/bin/env node
/**
 * 从任意目录把 cargo tauri 固定跑在仓库根（src-tauri/tauri.conf.json 所在工程）。
 * 用法：node scripts/tauri.mjs dev | build | ...
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const result = spawnSync("cargo", ["tauri", ...args], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

process.exit(result.status ?? 1);
