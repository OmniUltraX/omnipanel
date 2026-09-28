/**
 * 官方目录下载制品：文件名必须带上声明的版本，且 sha256 / integrity 不能同时为空。
 * 无制品 URL 的 bundled 条目不检查摘要。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "plugins", "registry.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];

let failed = 0;

function artifactsOf(plugin) {
  const out = [];
  if (plugin.artifact?.url) {
    out.push({ version: String(plugin.version ?? ""), artifact: plugin.artifact });
  }
  if (Array.isArray(plugin.versions)) {
    for (const ver of plugin.versions) {
      if (ver?.artifact?.url) {
        out.push({ version: String(ver.version ?? ""), artifact: ver.artifact });
      }
    }
  }
  return out;
}

for (const plugin of plugins) {
  const id = plugin?.id ?? "(missing id)";
  for (const { version, artifact } of artifactsOf(plugin)) {
    const url = String(artifact.url ?? "").trim();
    if (!url) continue;
    const file = decodeURIComponent(url.split("/").pop() ?? "");
    if (!version || !file.includes(version)) {
      console.error(
        `[plugin-registry] ${id} 制品文件名未包含版本 ${version || "(empty)"}: ${file}`,
      );
      failed += 1;
    }
    const sha = String(artifact.sha256 ?? "").trim();
    const integrity = String(artifact.integrity ?? "").trim();
    if (!sha && !integrity) {
      console.error(`[plugin-registry] ${id} ${version} 下载摘要为空`);
      failed += 1;
    } else if (sha && !/^[a-f0-9]{64}$/i.test(sha)) {
      console.error(`[plugin-registry] ${id} ${version} sha256 不是 64 位 hex`);
      failed += 1;
    }
  }
}

if (failed > 0) {
  console.error(`[plugin-registry] ${failed} error(s)`);
  process.exit(1);
}
console.log(`[plugin-registry] ok (${plugins.length} plugins)`);
