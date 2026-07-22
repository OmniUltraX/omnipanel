#!/usr/bin/env node
/**
 * 将 GitHub Release 的 Tauri updater 资产同步到阿里云 OSS，并改写 latest.json 下载地址。
 *
 * ## OSS 路径约定
 * - 版本产物：`{PUBLIC_BASE}/omnipanel/releases/{tag}/<原文件名>`
 * - 稳定清单：`{PUBLIC_BASE}/omnipanel/releases/latest.json`（客户端检查更新优先读此文件）
 *
 * ## 所需环境变量 / GitHub Secrets（同名）
 * - `ALIYUN_OSS_ACCESS_KEY_ID`
 * - `ALIYUN_OSS_ACCESS_KEY_SECRET`
 * - `ALIYUN_OSS_BUCKET`
 * - `ALIYUN_OSS_ENDPOINT`（如 `oss-cn-hangzhou.aliyuncs.com`，不要带 https://）
 * - `ALIYUN_OSS_PUBLIC_BASE_URL`（公网/CDN 根，无尾斜杠，如 `https://cdn.example.com`）
 *
 * ## 运维注意
 * - Bucket（或 CDN 回源）需对 `omnipanel/releases/` **公共读**，否则客户端无法匿名下载。
 * - 发版 CI 在构建前会跑 `scripts/check-aliyun-oss.mjs`（写探测对象 + 公网 GET）。
 * - 签名文件与安装包一并上传；只改托管地址，不改 Tauri updater 签名。
 * - 客户端 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints` 顺序为：
 *   OSS latest.json → xget → GitHub。发版 CI 会用 `ALIYUN_OSS_PUBLIC_BASE_URL`
 *   注入首项为 `{PUBLIC_BASE}/omnipanel/releases/latest.json`（须与本脚本稳定清单一致）。
 * - 仓库内 `tauri.conf.json` 的 OSS URL 为占位/默认；**以 GitHub Secrets 中的
 *   `ALIYUN_OSS_PUBLIC_BASE_URL` 为准**（构建时写入二进制）。
 *
 * ## 用法
 * ```bash
 * node scripts/publish-updater-to-aliyun-oss.mjs --dir ./release-assets --tag v0.5.0 --repo owner/name
 * ```
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const RELEASE_PREFIX = "omnipanel/releases";

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "用法: node scripts/publish-updater-to-aliyun-oss.mjs --dir <资产目录> --tag <tag> --repo <owner/name>",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { dir: "", tag: "", repo: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dir") out.dir = argv[++i] ?? "";
    else if (a === "--tag") out.tag = argv[++i] ?? "";
    else if (a === "--repo") out.repo = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") usageAndExit("", 0);
  }
  return out;
}

function requireEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function githubDownloadPrefix(repo, tag) {
  return `https://github.com/${repo}/releases/download/${tag}/`;
}

function collectUrls(value, acc = []) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, acc);
    return acc;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectUrls(child, acc);
  }
  return acc;
}

function rewriteGithubUrls(text, fromPrefix, toPrefix) {
  // 兼容 tag 大小写 / 编码差异：按 releases/download/{tag}/ 段替换
  const escapedFrom = fromPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escapedFrom, "g");
  return text.replace(re, toPrefix);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.tag || !args.repo) {
    usageAndExit("参数不完整");
  }

  const assetsDir = path.resolve(args.dir);
  if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
    throw new Error(`资产目录不存在: ${assetsDir}`);
  }

  const accessKeyId = requireEnv("ALIYUN_OSS_ACCESS_KEY_ID");
  const accessKeySecret = requireEnv("ALIYUN_OSS_ACCESS_KEY_SECRET");
  const bucket = requireEnv("ALIYUN_OSS_BUCKET");
  const endpoint = normalizeEndpoint(requireEnv("ALIYUN_OSS_ENDPOINT"));
  const publicBase = stripTrailingSlash(requireEnv("ALIYUN_OSS_PUBLIC_BASE_URL"));

  let OSS;
  try {
    OSS = require("ali-oss");
  } catch {
    throw new Error("未找到 ali-oss，请先在 CI 中执行: npm install ali-oss");
  }

  const client = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
    // 公网 endpoint；内网可再配
    secure: true,
    timeout: 10 * 60 * 1000,
  });

  const tag = args.tag;
  const tagPrefix = `${RELEASE_PREFIX}/${tag}`;
  const ossAssetBase = `${publicBase}/${tagPrefix}`;
  const fromPrefix = githubDownloadPrefix(args.repo, tag);
  const toPrefix = `${ossAssetBase}/`;

  const entries = fs
    .readdirSync(assetsDir)
    .map((name) => ({ name, full: path.join(assetsDir, name) }))
    .filter((e) => fs.statSync(e.full).isFile());

  if (entries.length === 0) {
    throw new Error(`资产目录为空: ${assetsDir}`);
  }

  console.log(`上传 ${entries.length} 个文件到 oss://${bucket}/${tagPrefix}/`);
  for (const entry of entries) {
    const objectKey = `${tagPrefix}/${entry.name}`;
    const size = fs.statSync(entry.full).size;
    console.log(`  put ${objectKey} (${size} bytes)`);
    await client.put(objectKey, entry.full, {
      headers: {
        "Cache-Control": entry.name === "latest.json" ? "no-cache" : "public, max-age=31536000",
      },
    });
  }

  const latestPath = path.join(assetsDir, "latest.json");
  if (!fs.existsSync(latestPath)) {
    throw new Error(`未找到 latest.json: ${latestPath}`);
  }

  const raw = fs.readFileSync(latestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`latest.json 不是合法 JSON: ${e}`);
  }

  const beforeUrls = collectUrls(parsed);
  const rewrittenText = rewriteGithubUrls(raw, fromPrefix, toPrefix);
  let rewritten;
  try {
    rewritten = JSON.parse(rewrittenText);
  } catch (e) {
    throw new Error(`改写后 latest.json 非法: ${e}`);
  }
  const afterUrls = collectUrls(rewritten);

  console.log("latest.json URL 改写摘要:");
  console.log(`  from: ${fromPrefix}`);
  console.log(`  to:   ${toPrefix}`);
  console.log("  before:");
  for (const u of beforeUrls) console.log(`    - ${u}`);
  console.log("  after:");
  for (const u of afterUrls) console.log(`    - ${u}`);

  const stillGithub = afterUrls.filter((u) => u.includes("github.com/"));
  if (stillGithub.length > 0) {
    console.warn("警告: 改写后仍含 github.com URL（可能来自 notes/其他字段）:");
    for (const u of stillGithub) console.warn(`    - ${u}`);
  }

  const stableKey = `${RELEASE_PREFIX}/latest.json`;
  const localRewritten = path.join(assetsDir, "latest.oss.json");
  fs.writeFileSync(localRewritten, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");

  console.log(`上传稳定清单 oss://${bucket}/${stableKey}`);
  await client.put(stableKey, localRewritten, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  // 同步一份改写后的 latest.json 到版本目录，便于对照
  await client.put(`${tagPrefix}/latest.json`, localRewritten, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  const clientEndpoint = `${publicBase}/${RELEASE_PREFIX}/latest.json`;
  console.log("完成。客户端 updater.endpoints 首项应为:");
  console.log(`  ${clientEndpoint}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
