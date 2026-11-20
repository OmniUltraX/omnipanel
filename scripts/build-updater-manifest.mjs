#!/usr/bin/env node
/**
 * 用各平台独立上传的 `.sig` 生成一份 `latest.json`。
 *
 * tauri-action 在矩阵里并行改同一个 `latest.json` 时，会互相删除资产并返回 404，
 * 后写入的清单还会丢掉其他平台。签名文件名带平台，可以并行上传；清单只在这里写一次。
 *
 * 用法:
 *   node scripts/build-updater-manifest.mjs --dir release-assets --tag v0.8.64 --repo owner/name --changelog CHANGELOG.md
 */

import fs from "node:fs";
import path from "node:path";

const REQUIRED = [
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "windows-x86_64",
  "windows-x86_64-nsis",
  "windows-x86_64-msi",
  "darwin-aarch64",
  "darwin-aarch64-app",
];

const RULES = [
  { test: /amd64\.AppImage\.sig$/, keys: ["linux-x86_64", "linux-x86_64-appimage"] },
  { test: /amd64\.deb\.sig$/, keys: ["linux-x86_64-deb"] },
  { test: /x64-setup\.exe\.sig$/, keys: ["windows-x86_64", "windows-x86_64-nsis"] },
  { test: /x64_.+\.msi\.sig$/, keys: ["windows-x86_64-msi"] },
  { test: /aarch64\.app\.tar\.gz\.sig$/, keys: ["darwin-aarch64", "darwin-aarch64-app"] },
];

function usageAndExit(message) {
  if (message) console.error(message);
  console.error(
    "用法: node scripts/build-updater-manifest.mjs --dir <资产目录> --tag <tag> --repo <owner/name> --changelog <CHANGELOG.md>",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = { dir: "", tag: "", repo: "", changelog: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") out.dir = argv[++i] ?? "";
    else if (arg === "--tag") out.tag = argv[++i] ?? "";
    else if (arg === "--repo") out.repo = argv[++i] ?? "";
    else if (arg === "--changelog") out.changelog = argv[++i] ?? "";
    else usageAndExit(`未知参数: ${arg}`);
  }
  if (!out.dir || !out.tag || !out.repo || !out.changelog) usageAndExit("参数不完整");
  return out;
}

function changelogNotes(changelogPath, version) {
  const text = fs.readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(
      `^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n---\\s*\\n|\\n## \\[|(?![\\s\\S]))`,
      "m",
    ),
  );
  if (!match) throw new Error(`CHANGELOG.md 中未找到 ## [${version}]`);
  return match[1].trim();
}

const args = parseArgs(process.argv.slice(2));
const version = args.tag.replace(/^v/, "");
const signatures = fs.readdirSync(args.dir).filter((name) => name.endsWith(".sig"));
if (signatures.length === 0) throw new Error(`目录中没有签名文件: ${args.dir}`);

const platforms = {};
for (const name of signatures) {
  const rule = RULES.find((item) => item.test.test(name));
  if (!rule) throw new Error(`未识别的签名文件: ${name}`);
  const asset = name.slice(0, -".sig".length);
  const entry = {
    signature: fs.readFileSync(path.join(args.dir, name), "utf8"),
    url: `https://github.com/${args.repo}/releases/download/${args.tag}/${asset}`,
  };
  for (const key of rule.keys) {
    if (platforms[key]) throw new Error(`平台 ${key} 有多份签名`);
    platforms[key] = entry;
  }
}

const missing = REQUIRED.filter((key) => !platforms[key]);
if (missing.length > 0) throw new Error(`更新清单缺少平台: ${missing.join(", ")}`);

const manifest = {
  version,
  notes: changelogNotes(args.changelog, version),
  pub_date: new Date().toISOString(),
  platforms,
};
const target = path.join(args.dir, "latest.json");
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已生成 ${target}，平台: ${Object.keys(platforms).join(", ")}`);
