#!/usr/bin/env node
/**
 * 本地打包全部 download-only 云插件，回填 plugins/registry.json 的 sha256/size，
 * 并（若已登录 gh / 设置了 GH_TOKEN）上传到 OmniUltraX/omnipanel 的 plugins-latest Release。
 *
 * 用法：
 *   node scripts/publish-cloud-plugins.mjs           # 仅 pack + 回填 registry
 *   node scripts/publish-cloud-plugins.mjs --upload  # pack + 回填 + gh release upload
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOWNLOAD_ONLY_PLUGIN_DIRS } from "./plugin-download-only.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const wantUpload = process.argv.includes("--upload");
const clouds = [...DOWNLOAD_ONLY_PLUGIN_DIRS]
  .filter((d) => d.startsWith("cloud-"))
  .sort();

fs.mkdirSync(distDir, { recursive: true });

const packed = [];
for (const dir of clouds) {
  const manifestPath = path.join(root, "plugins", dir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const asset = `${manifest.id.replaceAll(".", "-")}-${manifest.version}.omni-plugin`;
  const out = path.join(distDir, asset);
  console.log(`[pack] ${dir} -> ${asset}`);
  execFileSync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "omnipanel-plugin-pkg",
      "--bin",
      "pack",
      "--",
      path.join("plugins", dir),
      path.join("dist", asset),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const bytes = fs.readFileSync(out);
  packed.push({
    id: manifest.id,
    version: manifest.version,
    asset,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

execFileSync("node", ["scripts/generate-plugin-registry.mjs"], {
  cwd: root,
  stdio: "inherit",
});

const registryPath = path.join(root, "plugins", "registry.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
for (const item of packed) {
  const entry = registry.plugins.find((p) => p.id === item.id);
  if (!entry) throw new Error(`registry 缺少 ${item.id}`);
  const artifact = {
    url: `https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest/${item.asset}`,
    sha256: item.sha256,
    size: item.size,
  };
  if (Array.isArray(entry.versions) && entry.versions.length) {
    entry.versions[0].version = item.version;
    entry.versions[0].artifact = artifact;
  } else {
    entry.versions = [{ version: item.version, artifact }];
  }
  console.log(`[registry] ${item.id} sha256=${item.sha256.slice(0, 12)}… size=${item.size}`);
}
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

const releaseRegistry = path.join(distDir, "plugin-registry.json");
fs.copyFileSync(registryPath, releaseRegistry);
fs.writeFileSync(
  path.join(distDir, "cloud-pack-manifest.json"),
  JSON.stringify(packed, null, 2) + "\n",
);

if (!wantUpload) {
  console.log(
    `\n已打包 ${packed.length} 个云插件到 dist/。上传请执行：\n` +
      `  node scripts/publish-cloud-plugins.mjs --upload\n` +
      `或先提交推送 master，触发 publish-plugin-registry.yml。`,
  );
  process.exit(0);
}

const assets = packed.map((p) => path.join(distDir, p.asset));
assets.push(releaseRegistry);
console.log(`[upload] plugins-latest ← ${assets.length} files`);
try {
  execFileSync(
    "gh",
    [
      "release",
      "upload",
      "plugins-latest",
      ...assets,
      "--repo",
      "OmniUltraX/omnipanel",
      "--clobber",
    ],
    { cwd: root, stdio: "inherit" },
  );
} catch {
  console.error(
    "\n上传失败：请先 `gh auth login`，或设置环境变量 GH_TOKEN / GITHUB_TOKEN 后重试。",
  );
  process.exit(1);
}
console.log("\n上传完成。市场源：");
console.log(
  "https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest/plugin-registry.json",
);
