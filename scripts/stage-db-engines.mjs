#!/usr/bin/env node
/**
 * 编译数据库 sidecar，放到 src-tauri/binaries/（Tauri externalBin 命名）。
 *
 * 默认不改仓库里的 tauri.conf.json，避免 `tauri dev` 因缺二进制失败。
 * 发版 CI 加 --patch-tauri-conf，仅在本次工作区写入 externalBin。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binariesDir = path.join(root, "src-tauri", "binaries");

const DEFAULT_ENGINES = [
  "omnipanel-engine-clickhouse",
  "omnipanel-engine-mongodb",
  "omnipanel-engine-redis",
];
const SQL_ENGINES = ["omnipanel-engine-mysql", "omnipanel-engine-postgres"];

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function defaultTriple() {
  const fromEnv = process.env.OMNIPANEL_TARGET_TRIPLE?.trim();
  if (fromEnv) return fromEnv;
  const p = process.platform;
  const a = process.arch;
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`无法推断 target triple（platform=${p} arch=${a}），请传 --target`);
}

function exeName(stem) {
  return process.platform === "win32" ? `${stem}.exe` : stem;
}

function runCargo(args) {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(cargo, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

function sqlSidecarsRequested() {
  if (hasFlag("--sql")) return true;
  const v = (process.env.OMNIPANEL_SQL_SIDECAR || "").trim();
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

const release = hasFlag("--release");
const explicitTarget =
  argValue("--target") || process.env.OMNIPANEL_TARGET_TRIPLE?.trim() || "";
const target = explicitTarget || defaultTriple();
const patchConf = hasFlag("--patch-tauri-conf");
const confOut = argValue("--conf-out");
const skipBuild = hasFlag("--skip-build");
const engines = sqlSidecarsRequested()
  ? [...DEFAULT_ENGINES, ...SQL_ENGINES]
  : DEFAULT_ENGINES;

fs.mkdirSync(binariesDir, { recursive: true });

if (!skipBuild) {
  for (const pkg of engines) {
    const cargoArgs = ["build", "-p", pkg];
    if (release) cargoArgs.push("--release");
    if (explicitTarget) cargoArgs.push("--target", explicitTarget);
    console.log(`stage-db-engines: cargo ${cargoArgs.join(" ")}`);
    runCargo(cargoArgs);
  }
}

const profile = release ? "release" : "debug";
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, "target");

function findArtifact(stem) {
  const file = exeName(stem);
  const dirs = [
    path.join(targetDir, target, profile),
    path.join(targetDir, profile),
    path.join(root, "target", target, profile),
    path.join(root, "target", profile),
    path.join(root, "target-sidecar-verify", profile),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

for (const stem of engines) {
  const src = findArtifact(stem);
  if (!src) {
    console.error(
      `stage-db-engines: 找不到产物 ${exeName(stem)}（已搜 target/${target}/${profile} 与 target/${profile}）`,
    );
    process.exit(1);
  }
  const dest = path.join(binariesDir, exeName(`${stem}-${target}`));
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // Windows 可忽略
  }
  const stat = fs.statSync(dest);
  if (stat.size < 1024) {
    console.error(`stage-db-engines: ${path.relative(root, dest)} 过小，不像可执行文件`);
    process.exit(1);
  }
  console.log(`staged ${path.relative(root, dest)} (${stat.size} bytes)`);
}

if (patchConf || confOut) {
  const confPath = path.join(root, "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  conf.bundle = conf.bundle || {};
  conf.bundle.externalBin = engines.map((stem) => `binaries/${stem}`);
  const dest = confOut || confPath;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(conf, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(root, dest) || dest} bundle.externalBin (${engines.length} sidecars, host=${os.hostname()})`,
  );
}
