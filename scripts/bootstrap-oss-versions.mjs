#!/usr/bin/env node
/**
 * 用公网 latest.json 引导写入 versions.json（官网下载页历史列表）。
 *
 * 需要与 publish-updater-to-aliyun-oss.mjs 相同的 ALIYUN_OSS_* 环境变量。
 *
 * 用法:
 *   # 仅生成本地文件（无需密钥，再手动上传到 OSS）
 *   node scripts/bootstrap-oss-versions.mjs --out ./versions.json --base https://omnipanel.oss-cn-beijing.aliyuncs.com
 *
 *   # 直接上传（需 ALIYUN_OSS_*，与发版 CI Secrets 同名）
 *   node scripts/bootstrap-oss-versions.mjs --base https://omnipanel.oss-cn-beijing.aliyuncs.com
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const RELEASE_PREFIX = "omnipanel/releases";

function requireEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function normalizeTag(tagOrVersion) {
  const v = String(tagOrVersion ?? "").trim();
  if (!v) return "";
  return v.startsWith("v") ? v : `v${v}`;
}

function parseArgs(argv) {
  let base = process.env.ALIYUN_OSS_PUBLIC_BASE_URL?.trim() || "";
  let out = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") base = argv[++i] ?? "";
    else if (argv[i] === "--out") out = argv[++i] ?? "";
  }
  return { base: stripTrailingSlash(base), out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publicBase =
    args.base ||
    (process.env.ALIYUN_OSS_PUBLIC_BASE_URL
      ? stripTrailingSlash(process.env.ALIYUN_OSS_PUBLIC_BASE_URL)
      : "https://omnipanel.oss-cn-beijing.aliyuncs.com");

  const latestUrl = `${publicBase}/${RELEASE_PREFIX}/latest.json`;
  console.log(`读取 ${latestUrl}`);
  const res = await fetch(latestUrl);
  if (!res.ok) throw new Error(`读取 latest.json 失败: HTTP ${res.status}`);
  const latest = await res.json();

  const entry = {
    tag: normalizeTag(latest.version),
    version: String(latest.version ?? "").replace(/^v/, ""),
    notes: typeof latest.notes === "string" ? latest.notes : "",
    pub_date: typeof latest.pub_date === "string" ? latest.pub_date : "",
    platforms: latest.platforms ?? {},
  };

  const index = {
    updatedAt: new Date().toISOString(),
    versions: [entry],
  };

  const key = `${RELEASE_PREFIX}/versions.json`;
  const body = `${JSON.stringify(index, null, 2)}\n`;

  // 仅写本地：无需 AK/SK，上传到控制台路径 omnipanel/releases/versions.json
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, body, "utf8");
    console.log(`已写入 ${outPath}`);
    console.log(`请上传为公共读对象: ${publicBase}/${key}`);
    return;
  }

  let OSS;
  try {
    OSS = require("ali-oss");
  } catch {
    throw new Error("未找到 ali-oss，请先执行: npm install ali-oss");
  }

  const client = new OSS({
    accessKeyId: requireEnv("ALIYUN_OSS_ACCESS_KEY_ID"),
    accessKeySecret: requireEnv("ALIYUN_OSS_ACCESS_KEY_SECRET"),
    bucket: requireEnv("ALIYUN_OSS_BUCKET"),
    endpoint: normalizeEndpoint(requireEnv("ALIYUN_OSS_ENDPOINT")),
    secure: true,
  });

  const tmp = path.join(os.tmpdir(), "omnipanel-versions.json");
  fs.writeFileSync(tmp, body, "utf8");

  // 若已有索引则合并（不覆盖其它版本）
  try {
    const existing = await client.get(key);
    const parsed = JSON.parse(existing.content.toString("utf8"));
    const versions = Array.isArray(parsed?.versions) ? [...parsed.versions] : [];
    const idx = versions.findIndex(
      (v) => normalizeTag(v?.tag) === entry.tag || v?.version === entry.version,
    );
    if (idx >= 0) versions[idx] = entry;
    else versions.unshift(entry);
    index.versions = versions;
    index.updatedAt = new Date().toISOString();
    fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    console.log(`合并已有 versions.json，共 ${versions.length} 个版本`);
  } catch (e) {
    if (e?.code !== "NoSuchKey" && e?.status !== 404) throw e;
    console.log("新建 versions.json");
  }

  await client.put(key, tmp, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  console.log(`已上传 ${publicBase}/${key}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
