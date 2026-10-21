#!/usr/bin/env node
/**
 * 构建前把仓库 plugins/registry.json 镜像到 public/plugins/，
 * 供官网插件市场同域读取。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(websiteRoot, "..");
const src = path.join(repoRoot, "plugins", "registry.json");
const outDir = path.join(websiteRoot, "public", "plugins");
const outFile = path.join(outDir, "registry.json");

if (!fs.existsSync(src)) {
  console.warn(`[sync-plugins] missing ${src}`);
  if (process.env.CI === "true") process.exitCode = 1;
  process.exit(process.exitCode ? 1 : 0);
}

const text = fs.readFileSync(src, "utf8");
JSON.parse(text);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, text.endsWith("\n") ? text : `${text}\n`, "utf8");
console.log(`[sync-plugins] wrote public/plugins/registry.json <- plugins/registry.json`);
