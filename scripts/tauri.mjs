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

// `tauri:dev` 默认开启 MCP Bridge（feature:dev-mcp）；显式传 --features 时不覆盖。
const hasFeatures =
  args.includes("--features") || args.some((a) => a.startsWith("--features="));
if (args[0] === "dev" && !hasFeatures) {
  args.splice(1, 0, "--features", "dev-mcp");
}

// 开发构建使用独立 identifier / 产品名 / 带 DEV 角标图标，可与正式安装版并存。
// 显式传 --config 时不覆盖。
const isDevFlavor =
  args[0] === "dev" || (args[0] === "build" && args.includes("--debug"));
const hasConfig =
  args.includes("--config") ||
  args.includes("-c") ||
  args.some((a) => a.startsWith("--config=") || a.startsWith("-c="));
if (isDevFlavor && !hasConfig) {
  args.splice(1, 0, "--config", "src-tauri/tauri.dev.conf.json");
}

const result = spawnSync("cargo", ["tauri", ...args], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

process.exit(result.status ?? 1);
