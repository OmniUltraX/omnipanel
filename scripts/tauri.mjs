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

/** 把 extra 合并进已有 --features，避免显式传 dev-mcp 时丢掉 plugin-js。 */
function ensureFeatures(argv, extra) {
  const extras = extra.split(",").map((s) => s.trim()).filter(Boolean);
  const idx = argv.findIndex((a) => a === "--features" || a.startsWith("--features="));
  if (idx === -1) {
    argv.splice(1, 0, "--features", extras.join(","));
    return;
  }
  const raw = argv[idx] === "--features" ? (argv[idx + 1] ?? "") : argv[idx].slice("--features=".length);
  const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  for (const feat of extras) set.add(feat);
  const merged = [...set].join(",");
  if (argv[idx] === "--features") argv[idx + 1] = merged;
  else argv[idx] = `--features=${merged}`;
}

// Tauri CLI 会 `--no-default-features`；dev 必须显式带上 MCP + L2。
if (args[0] === "dev") {
  ensureFeatures(args, "dev-mcp,plugin-js");
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
