#!/usr/bin/env node
/**
 * 发版前探测阿里云 OSS 是否可用（密钥、写权限、公网可读）。
 *
 * ## 所需环境变量 / GitHub Secrets（同名）
 * - `ALIYUN_OSS_ACCESS_KEY_ID`
 * - `ALIYUN_OSS_ACCESS_KEY_SECRET`
 * - `ALIYUN_OSS_BUCKET`
 * - `ALIYUN_OSS_ENDPOINT`（如 `oss-cn-hangzhou.aliyuncs.com`，不要带 https://）
 * - `ALIYUN_OSS_PUBLIC_BASE_URL`（公网/CDN 根，无尾斜杠）
 *
 * 探测对象：`omnipanel/releases/.ci-probe/ping.txt`（写后公网 GET，再删除）。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PROBE_KEY = "omnipanel/releases/.ci-probe/ping.txt";

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

async function main() {
  const accessKeyId = requireEnv("ALIYUN_OSS_ACCESS_KEY_ID");
  const accessKeySecret = requireEnv("ALIYUN_OSS_ACCESS_KEY_SECRET");
  const bucket = requireEnv("ALIYUN_OSS_BUCKET");
  const endpoint = normalizeEndpoint(requireEnv("ALIYUN_OSS_ENDPOINT"));
  const publicBase = stripTrailingSlash(requireEnv("ALIYUN_OSS_PUBLIC_BASE_URL"));

  let OSS;
  try {
    OSS = require("ali-oss");
  } catch {
    throw new Error("未找到 ali-oss，请先执行: npm install ali-oss");
  }

  const client = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
    secure: true,
    timeout: 60_000,
  });

  const payload = `omnipanel-oss-probe ${new Date().toISOString()}\n`;
  console.log(`写入探测对象 oss://${bucket}/${PROBE_KEY}`);
  await client.put(PROBE_KEY, Buffer.from(payload, "utf8"), {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/plain; charset=utf-8",
      // 若 Bucket 未开公共读，此 ACL 仍可能被拒绝；后续公网 GET 会明确失败
      "x-oss-object-acl": "public-read",
    },
  });

  const publicUrl = `${publicBase}/${PROBE_KEY}`;
  console.log(`公网读取: ${publicUrl}`);
  const response = await fetch(publicUrl, {
    method: "GET",
    redirect: "follow",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) {
    throw new Error(
      `公网读取失败 HTTP ${response.status}（请确认 Bucket/CDN 对 omnipanel/releases/ 公共可读，且 ALIYUN_OSS_PUBLIC_BASE_URL 正确）: ${publicUrl}`,
    );
  }
  const body = await response.text();
  if (!body.includes("omnipanel-oss-probe")) {
    throw new Error(`公网读取内容不符，请检查 CDN/回源是否指向正确 Bucket: ${publicUrl}`);
  }
  console.log("公网读取成功");

  try {
    await client.delete(PROBE_KEY);
    console.log("已删除探测对象");
  } catch (err) {
    console.warn("删除探测对象失败（可忽略）:", err instanceof Error ? err.message : err);
  }

  console.log("阿里云 OSS 可用");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
