#!/usr/bin/env node
/**
 * 构建前把 OSS 发版清单镜像到 public/releases/，
 * 供官网同域读取（规避浏览器 CORS）。下载链接仍指向 OSS。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "public", "releases");

const OSS_BASE =
  process.env.OMNIPANEL_OSS_RELEASES_BASE?.replace(/\/+$/, "") ||
  "https://omnipanel.oss-cn-beijing.aliyuncs.com/omnipanel/releases";

async function mirror(name) {
  const url = `${OSS_BASE}/${name}`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    console.warn(`[sync-releases] skip ${name}: HTTP ${res.status}`);
    return false;
  }
  const text = await res.text();
  // 基本校验 JSON
  JSON.parse(text);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), text.endsWith("\n") ? text : `${text}\n`, "utf8");
  console.log(`[sync-releases] wrote public/releases/${name} <- ${url}`);
  return true;
}

const latestOk = await mirror("latest.json");
await mirror("versions.json");

if (!latestOk) {
  console.warn("[sync-releases] latest.json 拉取失败，下载页将缺少同域回退");
  // CI 构建必须有镜像；本地离线开发不阻断
  if (process.env.CI === "true") process.exitCode = 1;
}
