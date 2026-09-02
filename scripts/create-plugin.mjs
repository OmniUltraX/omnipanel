#!/usr/bin/env node
/**
 * create-plugin — 第三方插件脚手架。
 *
 * 用法：node scripts/create-plugin.mjs <plugin-name> [engine|theme|module]
 *
 * 产出 plugins-custom/<plugin-name>/：
 *   - plugin.json   清单
 *   - logic.js      module 的 L2 桩（QuickJS）
 *   - README.md     打包与安装说明
 *
 * 打包：cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/<name> <name>.omni-plugin
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , rawName, kindArg] = process.argv;
const name = (rawName ?? "").trim();
const kind = (kindArg ?? "engine").trim().toLowerCase();

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("用法: node scripts/create-plugin.mjs <plugin-name> [engine|theme|module]");
  console.error("  plugin-name: 小写字母/数字/连字符，字母开头");
  process.exit(2);
}
if (!["engine", "theme", "module"].includes(kind)) {
  console.error(`不支持的 kind: ${kind}（当前支持 engine | theme | module）`);
  process.exit(2);
}

const dir = path.join(root, "plugins-custom", name);
if (existsSync(dir)) {
  console.error(`已存在: ${dir}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const id = `omni.${kind}.${name}`;
let manifest;
if (kind === "engine") {
  manifest = {
    id,
    version: "0.1.0",
    kind: "engine",
    permissions: ["net:connect"],
    contributes: {
      ui: {
        connectionForm: {
          engineKey: name,
          aliases: [name],
          defaultPort: 8080,
          icon: name.slice(0, 2).toUpperCase(),
          fields: [
            { key: "host", type: "text" },
            { key: "port", type: "number" },
            { key: "password", type: "password" },
          ],
        },
        workbench: { tree: "none", editor: "none", preview: "none", connectionInfo: "sql" },
      },
    },
  };
} else if (kind === "theme") {
  manifest = {
    id,
    version: "0.1.0",
    kind: "theme",
    permissions: [],
    contributes: {
      themes: {
        tokens: {
          id,
          js: false,
        },
      },
    },
  };
} else {
  manifest = {
    id,
    version: "0.1.0",
    kind: "module",
    permissions: ["ui:sidebar", "net:connect", "vault:read", "connections:write"],
    entry: { logic: "logic.js" },
    methods: [
      { name: "testConnection", permissions: ["net:connect", "vault:read"] },
      { name: "getServerInfo", permissions: ["net:connect", "vault:read"] },
      { name: "probeHealth", permissions: ["net:connect"] },
      { name: "listConfigs", permissions: ["net:connect", "vault:read"] },
      { name: "getConfig", permissions: ["net:connect", "vault:read"] },
    ],
    contributes: {
      ui: {
        sidebar: true,
        moduleKey: name,
        connectionForm: {
          fields: [
            { key: "host", type: "text" },
            { key: "port", type: "number" },
            { key: "contextPath", type: "text", optional: true },
            { key: "username", type: "text", optional: true },
            { key: "password", type: "password", optional: true },
          ],
        },
      },
      module: {
        capabilities: [{ id: "config", columns: [{ key: "dataId" }], actions: [] }],
        probe: { ports: [8080], healthPath: "/health", contextPath: "" },
      },
      discovery: [{ probeId: "module-http" }],
      launcher: { prefix: name },
    },
  };
}

writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (kind === "module") {
  writeFileSync(
    path.join(dir, "logic.js"),
    `function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}
function testConnection(args) {
  var host = String(args.host || "127.0.0.1");
  var port = Number(args.port || 8080);
  return { ok: true, dialect: "auto", auth: args.username ? "basic" : "none", host: host, port: port };
}
function getServerInfo(args) { return testConnection(args); }
function probeHealth(args) {
  try { return testConnection(args); }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}
function listConfigs() { return { items: [] }; }
function getConfig(args) { return { dataId: args.dataId || "", content: "" }; }
var HANDLERS = {
  testConnection: testConnection,
  getServerInfo: getServerInfo,
  probeHealth: probeHealth,
  listConfigs: listConfigs,
  getConfig: getConfig
};
function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}
globalThis.call = call;
`,
  );
}

writeFileSync(
  path.join(dir, "README.md"),
  `# ${name} — OmniPanel 插件（${kind}）

由 \`scripts/create-plugin.mjs\` 生成。

## 打包

\`\`\`bash
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/${name} ${name}.omni-plugin
\`\`\`

## 安装

设置 → 插件 → 「安装本地插件」选择 \`${name}.omni-plugin\`。

- 与内置同 id 的包会被拒绝覆盖。
- module：启用后侧栏出现入口；卸载后入口消失，已保存的 service 连接仍在。
`,
);

console.log(`已生成 ${path.relative(root, dir)}`);
console.log(`打包: cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/${name} ${name}.omni-plugin`);
