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
const engineKeys = [];
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
  if (raw.methods != null) {
    if (!Array.isArray(raw.methods)) errors.push("methods must be an array");
    else {
      const seen = new Set();
      for (const m of raw.methods) {
        if (!m || typeof m !== "object") errors.push("methods[] entries must be objects");
        else {
          if (typeof m.name !== "string" || !m.name.trim()) errors.push("methods[].name required");
          else if (seen.has(m.name)) errors.push(`duplicate method ${m.name}`);
          else seen.add(m.name);
          if (m.permissions != null && !Array.isArray(m.permissions))
            errors.push("methods[].permissions must be an array");
          else
            for (const p of m.permissions ?? []) {
              if (!PERMISSIONS.has(p)) errors.push(`unknown permission ${p}`);
            }
        }
      }
    }
  }
  if (raw.runtime != null) {
    if (!["inproc", "sidecar", "http"].includes(raw.runtime)) {
      errors.push("runtime must be inproc | sidecar | http");
    }
    if (raw.runtime === "sidecar" && !raw.entry?.driver) {
      errors.push("runtime=sidecar 必须声明 entry.driver");
    }
  }
  if (raw.kind === "engine") {
    if (!raw.runtime) errors.push("engine 插件必须声明 runtime");
    const engineKey = raw.contributes?.ui?.connectionForm?.engineKey;
    if (typeof engineKey !== "string" || !engineKey.trim()) {
      errors.push("engine 插件必须声明 contributes.ui.connectionForm.engineKey");
    } else {
      engineKeys.push({ dir: dir.name, key: engineKey.trim().toLowerCase() });
    }
  }
  if (raw.entry != null) {
    if (typeof raw.entry !== "object") errors.push("entry must be an object");
    else {
      const logic = raw.entry.logic;
      if (logic != null) {
        if (typeof logic !== "string" || !logic.trim()) errors.push("entry.logic required");
        else {
          if (!/\.(wasm|js)$/i.test(logic)) errors.push("entry.logic must be .wasm or .js");
          if (logic.startsWith("/") || logic.split(/[\\/]/).includes(".."))
            errors.push("entry.logic must be relative without '..'");
        }
      }
      const driver = raw.entry.driver;
      if (driver != null) {
        if (typeof driver !== "string" || !driver.trim()) errors.push("entry.driver required");
        else if (driver.startsWith("/") || driver.split(/[\\/]/).includes(".."))
          errors.push("entry.driver must be relative without '..'");
      }
    }
  }
  if (raw.minHostApi != null && (!Number.isInteger(raw.minHostApi) || raw.minHostApi < 1)) {
    errors.push("minHostApi must be a positive integer");
  }
  const home = raw.contributes?.ui?.home;
  if (home != null) {
    if (typeof home !== "object" || Array.isArray(home)) {
      errors.push("ui.home must be an object");
    } else {
      if (home.show != null && typeof home.show !== "boolean") {
        errors.push("ui.home.show must be boolean");
      }
      if (typeof home.title !== "string" || !home.title.trim()) {
        errors.push("ui.home.title required");
      }
      if (home.icon != null) {
        if (typeof home.icon !== "string" || !home.icon.trim()) {
          errors.push("ui.home.icon must be a relative svg/png path");
        } else if (
          home.icon.startsWith("/") ||
          home.icon.includes("://") ||
          home.icon.split(/[\\/]/).includes("..") ||
          !/\.(svg|png)$/i.test(home.icon)
        ) {
          errors.push("ui.home.icon must be a relative svg/png path without '..'");
        }
      }
      const open = home.open;
      if (!open || typeof open !== "object") {
        errors.push("ui.home.open required");
      } else {
        if (!["overlay", "importer", "module"].includes(open.kind)) {
          errors.push("ui.home.open.kind must be overlay | importer | module");
        }
        if (typeof open.id !== "string" || !open.id.trim()) {
          errors.push("ui.home.open.id required");
        }
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

const seenEngineKeys = new Map();
for (const { dir, key } of engineKeys) {
  if (seenEngineKeys.has(key)) {
    console.error(
      `[plugin-manifest] 重复的 engineKey "${key}": ${seenEngineKeys.get(key)} 与 ${dir}`,
    );
    failed += 1;
  } else {
    seenEngineKeys.set(key, dir);
  }
}

const missingIds = rustIds.filter((id) => !jsonIds.includes(id));
if (missingIds.length > 0) {
  console.error(`[plugin-manifest] PLUGIN_ID_* 与 JSON.id 不一致: ${missingIds.join(", ")}`);
  failed += 1;
}

const registryPath = path.join(pluginsDir, "registry.json");
if (!fs.existsSync(registryPath)) {
  console.error("[plugin-manifest] 缺少 plugins/registry.json，请运行 node scripts/generate-plugin-registry.mjs");
  failed += 1;
} else {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const bundledIds = new Set(
      (Array.isArray(registry.plugins) ? registry.plugins : [])
        .filter((p) => p && p.distribution === "bundled")
        .map((p) => p.id),
    );
    for (const id of jsonIds) {
      if (!bundledIds.has(id)) {
        console.error(`[plugin-manifest] 官方目录未收录第一方插件: ${id}`);
        failed += 1;
      }
    }
  } catch (err) {
    console.error(`[plugin-manifest] plugins/registry.json 无法解析 (${err})`);
    failed += 1;
  }
}

// 前端单源目录必须与 plugins/ 目录一一对应（防手写数组漂移）。
const catalogPath = path.join(root, "frontend", "src", "lib", "pluginManifests.ts");
const catalogSrc = fs.readFileSync(catalogPath, "utf8");
const catalogDirs = [...catalogSrc.matchAll(/\/plugins\/([^/\s"']+?)\/plugin\.json"/g)].map(
  (m) => m[1],
);
const catalogDirSet = new Set(catalogDirs);
if (catalogDirSet.size !== catalogDirs.length) {
  console.error("[plugin-manifest] 前端 pluginManifests.ts 存在重复的 plugin.json import");
  failed += 1;
}
for (const dir of jsonDirs) {
  if (!catalogDirSet.has(dir)) {
    console.error(`[plugin-manifest] plugins/${dir} 未在前端 pluginManifests.ts 登记`);
    failed += 1;
  }
}
for (const dir of catalogDirSet) {
  if (!jsonDirs.includes(dir)) {
    console.error(`[plugin-manifest] 前端 pluginManifests.ts 引用不存在的 plugins/${dir}`);
    failed += 1;
  }
}
// 唯一合法桥接：清单单源目录 + Runtime Loader（阶段 A 静态登记；阶段 B 换磁盘/WASM 装载时仅替换其实现）。
const hostBridgeAllowlist = new Set([
  catalogPath,
  path.join(root, "frontend", "src", "lib", "pluginRuntimeLoader.ts"),
]);
const hostDirectImports = [];
const scanTs = (dirPath) => {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanTs(full);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !hostBridgeAllowlist.has(full)
    ) {
      const src = fs.readFileSync(full, "utf8");
      if (
        /from\s+"[^"]*\/plugins\/[^/]+\/src/.test(src) ||
        /from\s+"[^"]*plugins\/[^/]+\/plugin\.json"/.test(src)
      ) {
        hostDirectImports.push(path.relative(root, full));
      }
    }
  }
};
scanTs(path.join(root, "frontend", "src"));
for (const offender of hostDirectImports) {
  console.error(
    `[plugin-manifest] 宿主禁止直接 import 插件源码（走 lib/pluginManifests 单源）: ${offender}`,
  );
  failed += 1;
}

if (failed > 0) {
  process.exit(1);
}
console.log(
  `plugin manifests ok (${dirs.length}; rust dirs ${rustDirSet.size}; frontend catalog ${catalogDirSet.size})`,
);
