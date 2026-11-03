#!/usr/bin/env node
/**
 * 编译官方 Agent sidecar，拷进 plugins/agent-*/bin/，供 pack / 本地校验。
 *
 *   node scripts/stage-agent-sidecars.mjs
 *   node scripts/stage-agent-sidecars.mjs --release
 *   node scripts/stage-agent-sidecars.mjs --skip-build
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ packageName: string, pluginDir: string, binName: string }[]} */
const AGENTS = [
  {
    packageName: "omnipanel-agent-workbuddy",
    pluginDir: "agent-workbuddy",
    binName: "omnipanel-agent-workbuddy",
  },
  {
    packageName: "omnipanel-agent-cursor",
    pluginDir: "agent-cursor",
    binName: "omnipanel-agent-cursor",
  },
  {
    packageName: "omnipanel-agent-trae",
    pluginDir: "agent-trae",
    binName: "omnipanel-agent-trae",
  },
  {
    packageName: "omnipanel-agent-trae",
    pluginDir: "agent-trae-global",
    binName: "omnipanel-agent-trae-global",
  },
  {
    packageName: "omnipanel-agent-opencode-go",
    pluginDir: "agent-opencode-go",
    binName: "omnipanel-agent-opencode-go",
  },
];

function hasFlag(flag) {
  return process.argv.includes(flag);
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

const release = hasFlag("--release");
const skipBuild = hasFlag("--skip-build");
const profile = release ? "release" : "debug";
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, "target");

if (!skipBuild) {
  const packages = [...new Set(AGENTS.map((a) => a.packageName))];
  for (const pkg of packages) {
    const cargoArgs = ["build", "-p", pkg];
    if (release) cargoArgs.push("--release");
    console.log(`stage-agent-sidecars: cargo ${cargoArgs.join(" ")}`);
    runCargo(cargoArgs);
  }
}

function findArtifact(stem) {
  const file = exeName(stem);
  const dirs = [path.join(targetDir, profile), path.join(root, "target", profile)];
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

for (const agent of AGENTS) {
  const src = findArtifact(agent.binName);
  if (!src) {
    console.error(
      `stage-agent-sidecars: 找不到 ${exeName(agent.binName)}（已搜 target/${profile}）`,
    );
    process.exit(1);
  }
  const destDir = path.join(root, "plugins", agent.pluginDir, "bin");
  fs.mkdirSync(destDir, { recursive: true });
  // pack 时 entry.driver 无后缀；Windows 落盘 .exe，宿主 resolve 时补后缀。
  const destName = exeName(agent.binName);
  const dest = path.join(destDir, destName);
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // Windows 可忽略
  }
  const stat = fs.statSync(dest);
  console.log(`staged plugins/${agent.pluginDir}/bin/${destName} (${stat.size} bytes)`);
}

console.log("stage-agent-sidecars: done");
