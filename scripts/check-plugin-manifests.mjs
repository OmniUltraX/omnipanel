import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");
const sdkPath = path.join(root, "packages", "plugin-sdk", "src", "index.ts");
const firstPartyPath = path.join(root, "crates", "omnipanel-plugin", "src", "first_party.rs");

function extractZodEnum(src, name) {
  const re = new RegExp(`export const ${name} = z\\.enum\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const match = src.match(re);
  if (!match) {
    throw new Error(`[plugin-manifest] 无法从 plugin-sdk 提取 ${name}`);
  }
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

const sdkSrc = fs.readFileSync(sdkPath, "utf8");
const KINDS = extractZodEnum(sdkSrc, "pluginKindSchema");
const PERMISSIONS = extractZodEnum(sdkSrc, "pluginPermissionSchema");
const PLATFORMS = extractZodEnum(sdkSrc, "pluginPlatformSchema");

const firstPartySrc = fs.readFileSync(firstPartyPath, "utf8");
if (/PluginManifest\s*\{[\s\S]{0,80}id\s*:/.test(firstPartySrc)) {
  console.error("[plugin-manifest] first_party.rs 含手写 PluginManifest 构造，清单必须以 plugin.json 为唯一事实源");
  process.exit(1);
}

const rustDirs = [...firstPartySrc.matchAll(/first_party_manifest!\("([^"]+)"\)/g)].map((m) => m[1]);
const rustDirSet = new Set(rustDirs);
if (rustDirSet.size !== rustDirs.length) {
  console.error("[plugin-manifest] first_party.rs 宏目录重复");
  process.exit(1);
}

const idConstRe =
  /pub const PLUGIN_ID_[A-Z0-9_]+: &str = "([^"]+)";/g;
const rustIds = [...firstPartySrc.matchAll(idConstRe)].map((m) => m[1]);

const dirs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
const jsonDirs = dirs.map((d) => d.name);

let failed = 0;

for (const dir of jsonDirs) {
  if (!rustDirSet.has(dir)) {
    console.error(`[plugin-manifest] plugins/${dir} 未在 first_party.rs 用 first_party_manifest! 登记`);
    failed += 1;
  }
}
for (const dir of rustDirSet) {
  if (!jsonDirs.includes(dir)) {
    console.error(`[plugin-manifest] first_party.rs 引用 plugins/${dir} 但目录不存在`);
    failed += 1;
  }
}

const jsonIds = [];
for (const dir of dirs) {
  const file = path.join(pluginsDir, dir.name, "plugin.json");
  if (!fs.existsSync(file)) {
    console.error(`[plugin-manifest] missing ${path.relative(root, file)}`);
    failed += 1;
    continue;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[plugin-manifest] ${dir.name}: invalid JSON (${err})`);
    failed += 1;
    continue;
  }
  jsonIds.push(raw.id);
  const errors = [];
  if (typeof raw.id !== "string" || !raw.id.trim()) errors.push("id required");
  if (typeof raw.version !== "string" || !raw.version.trim()) errors.push("version required");
  if (!KINDS.has(raw.kind)) errors.push(`kind must be one of ${[...KINDS].join(", ")}`);
  if (raw.permissions != null) {
    if (!Array.isArray(raw.permissions)) errors.push("permissions must be an array");
    else {
      for (const p of raw.permissions) {
        if (!PERMISSIONS.has(p)) errors.push(`unknown permission ${p}`);
      }
    }
  }
  if (raw.platforms != null) {
    if (!Array.isArray(raw.platforms)) errors.push("platforms must be an array");
    else {
      for (const p of raw.platforms) {
        if (!PLATFORMS.has(p)) errors.push(`unknown platform ${p}`);
      }
    }
  }
  if (raw.kind === "theme") {
    const js = raw.contributes?.themes?.tokens?.js ?? raw.contributes?.themes?.js;
    if (js === true) errors.push("theme packs must not ship JS (js: true)");
  }
  if (errors.length > 0) {
    console.error(`[plugin-manifest] ${dir.name}:\n  - ${errors.join("\n  - ")}`);
    failed += 1;
  }
}

const missingIds = rustIds.filter((id) => !jsonIds.includes(id));
if (missingIds.length > 0) {
  console.error(`[plugin-manifest] PLUGIN_ID_* 与 JSON.id 不一致: ${missingIds.join(", ")}`);
  failed += 1;
}

if (failed > 0) {
  process.exit(1);
}
console.log(`plugin manifests ok (${dirs.length}; rust dirs ${rustDirSet.size})`);
