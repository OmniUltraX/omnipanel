#!/usr/bin/env node
/**
 * create-plugin — 第三方插件脚手架。
 *
 * 用法：node scripts/create-plugin.mjs <plugin-name> [engine|engine-sidecar|theme|module|cloud|panel|importer|addon]
 *
 * 产出 plugins-custom/<plugin-name>/：
 *   - plugin.json   清单
 *   - logic.js      module/cloud/panel/importer 的 L2 桩（QuickJS）
 *   - bin/agent.mjs engine-sidecar 的 Node 参考 agent（DBX 协议，开箱可跑）
 *   - src-agent-rs/ engine-sidecar 的 Rust 参考 agent（自包含 tokio+serde_json）
 *   - README.md     打包与安装说明
 *
 * 协议见 docs/plugins/sidecar-dbx.md；自测见 scripts/check-dbx-agent.mjs。
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

const KINDS = [
  "engine",
  "engine-sidecar",
  "theme",
  "module",
  "cloud",
  "panel",
  "importer",
  "addon",
  "js-logic",
  "l3-overlay",
  "wasm-stub",
];

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`用法: node scripts/create-plugin.mjs <plugin-name> [${KINDS.join("|")}]`);
  console.error("  plugin-name: 小写字母/数字/连字符，字母开头");
  process.exit(2);
}
if (!KINDS.includes(kind)) {
  console.error(`不支持的 kind: ${kind}（当前支持 ${KINDS.join(" | ")}）`);
  process.exit(2);
}

const dir = path.join(root, "plugins-custom", name);
if (existsSync(dir)) {
  console.error(`已存在: ${dir}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const engineSidecar = kind === "engine-sidecar";
const id = engineSidecar ? `omni.engine.${name}` : kind === "js-logic" || kind === "l3-overlay" || kind === "wasm-stub" ? `omni.sample.${name}` : `omni.${kind}.${name}`;
let manifest;
if (kind === "wasm-stub") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "addon",
    permissions: [],
    methods: [{ name: "echo", permissions: [] }],
    entry: { logic: "logic.wasm" },
    minHostApi: 1,
    contributes: { launcher: { prefix: name } },
  };
} else if (kind === "js-logic") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "addon",
    permissions: [],
    methods: [{ name: "echo", permissions: [] }],
    entry: { logic: "logic.js", ui: "ui/main.js" },
    minHostApi: 1,
    contributes: { launcher: { prefix: name } },
  };
} else if (kind === "l3-overlay") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "addon",
    permissions: ["ui:selection", "net:connect"],
    methods: [{ name: "translate", permissions: ["net:connect"] }],
    entry: { logic: "logic.js", ui: "ui/main.js" },
    minHostApi: 1,
    contributes: { overlays: [{ id: "main", title: name, entry: "ui/index.html" }] },
  };
} else if (engineSidecar) {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "engine",
    runtime: "sidecar",
    permissions: ["net:connect"],
    entry: { driver: "bin/agent.mjs" },
    contributes: {
      ui: {
        connectionForm: {
          engineKey: name,
          aliases: [name],
          defaultPort: 1521,
          icon: name.slice(0, 2).toUpperCase(),
          fields: [
            { key: "host", type: "text" },
            { key: "port", type: "number" },
            { key: "database", type: "text", optional: true },
            { key: "username", type: "text" },
            { key: "password", type: "password" },
            { key: "ssl", type: "checkbox" },
          ],
        },
        workbench: { tree: "schema", editor: "sql", preview: "grid", connectionInfo: "sql" },
      },
    },
  };
} else if (kind === "engine") {
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
} else if (kind === "cloud") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "cloud",
    permissions: ["connections:write", "net:connect", "vault:read"],
    entry: { logic: "logic.js" },
    methods: [
      { name: "testAccount", permissions: ["net:connect", "vault:read"] },
      { name: "listRegions", permissions: ["net:connect", "vault:read"] },
      { name: "getAccount", permissions: ["net:connect", "vault:read"] },
      { name: "listResources", permissions: ["net:connect", "vault:read"] },
      { name: "getResource", permissions: ["net:connect", "vault:read"] },
      {
        name: "invokeAction",
        permissions: ["net:connect", "vault:read"],
        dangerAction: "cloud.instance.lifecycle",
      },
      { name: "getMetrics", permissions: ["net:connect", "vault:read"] },
      { name: "queryLogs", permissions: ["net:connect", "vault:read"] },
    ],
    contributes: {
      ui: {
        sidebar: true,
        connectionForm: {
          fields: [
            { key: "accessKeyId", type: "text" },
            { key: "accessKeySecret", type: "password" },
            { key: "regions", type: "multiselect" },
          ],
        },
      },
      cloud: {
        capabilities: [
          {
            id: "compute",
            label: "计算",
            scope: "region",
            detailSlots: ["overview"],
            columns: [{ key: "name" }, { key: "status" }, { key: "region" }],
            actions: [
              { id: "start", kind: "plugin" },
              { id: "stop", kind: "plugin" },
            ],
          },
        ],
        regions: [],
      },
    },
  };
} else if (kind === "panel") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "panel",
    permissions: ["connections:write", "net:connect", "vault:read"],
    entry: { logic: "logic.js" },
    methods: [
      { name: "testConnection", permissions: ["net:connect", "vault:read"] },
      { name: "listDatabases", permissions: ["net:connect", "vault:read"] },
      { name: "createDatabase", permissions: ["net:connect", "vault:read"] },
      {
        name: "deleteDatabase",
        permissions: ["net:connect", "vault:read"],
        dangerAction: "panel.database.delete",
      },
      { name: "listWebsites", permissions: ["net:connect", "vault:read"] },
      { name: "setWebsiteStatus", permissions: ["net:connect", "vault:read"] },
      {
        name: "deleteWebsite",
        permissions: ["net:connect", "vault:read"],
        dangerAction: "panel.website.delete",
      },
      { name: "listCertificates", permissions: ["net:connect", "vault:read"] },
      {
        name: "deleteCertificate",
        permissions: ["net:connect", "vault:read"],
        dangerAction: "panel.certificate.delete",
      },
      { name: "listCronjobs", permissions: ["net:connect", "vault:read"] },
      { name: "setCronjobStatus", permissions: ["net:connect", "vault:read"] },
      { name: "runCronjob", permissions: ["net:connect", "vault:read"] },
      {
        name: "deleteCronjob",
        permissions: ["net:connect", "vault:read"],
        dangerAction: "panel.cronjob.delete",
      },
      { name: "listApps", permissions: ["net:connect", "vault:read"] },
      { name: "listInstalledApps", permissions: ["net:connect", "vault:read"] },
      { name: "getDashboard", permissions: ["net:connect", "vault:read"] },
    ],
    contributes: {
      ui: {
        panelTabs: [{ id: "overview" }, { id: "databases" }],
      },
    },
  };
} else if (kind === "importer") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "importer",
    permissions: ["connections:write", "net:connect", "vault:read"],
    entry: { logic: "logic.js" },
    methods: [{ name: "fetchTargets", permissions: ["net:connect", "vault:read"] }],
    contributes: {
      ui: {
        home: {
          show: true,
          title: name,
          open: { kind: "importer", id: name },
        },
      },
      importers: [
        {
          id: name,
          title: name,
          hint: `${name} 导入`,
          fetchMethod: "fetchTargets",
          defaultGroup: name,
          resourceKinds: ["ssh"],
          defaultTag: name,
          fields: [
            { key: "name", kind: "text", label: "名称" },
            { key: "baseUrl", kind: "url", label: "地址", required: true },
            { key: "token", kind: "secret", label: "令牌", required: true },
          ],
          entry: ["commandPalette", "settings", "home"],
        },
      ],
    },
  };
} else if (kind === "addon") {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "addon",
    permissions: [],
    contributes: {
      launcher: { prefix: name },
    },
  };
} else {
  manifest = {
    id,
    version: "0.1.0",
    displayName: name,
    kind: "module",
    permissions: ["ui:sidebar", "net:connect", "vault:read", "connections:write"],
    entry: { logic: "logic.js" },
    methods: [
      { name: "testConnection", permissions: ["net:connect", "vault:read"] },
      { name: "getServerInfo", permissions: ["net:connect", "vault:read"] },
      { name: "probeHealth", permissions: ["net:connect"] },
      { name: "listItems", permissions: ["net:connect", "vault:read"] },
      { name: "getItem", permissions: ["net:connect", "vault:read"] },
    ],
    contributes: {
      ui: {
        sidebar: true,
        moduleKey: name,
        connectionForm: {
          fields: [
            { key: "host", type: "text" },
            { key: "port", type: "number" },
            { key: "username", type: "text", optional: true },
            { key: "password", type: "password", optional: true },
          ],
        },
      },
      module: {
        capabilities: [
          {
            id: "items",
            label: "资源",
            listMethod: "listItems",
            getMethod: "getItem",
            itemKey: "id",
            detail: "none",
            columns: [{ key: "name" }, { key: "status" }],
            actions: [],
          },
        ],
        probe: { ports: [8080], healthPath: "/health", contextPath: "" },
      },
      discovery: [{ probeId: "module-http" }],
    },
  };
}

writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (kind === "wasm-stub") {
  writeFileSync(
    path.join(dir, "logic.wat"),
    `;; WASM 逻辑包样板（ABI：memory + call(m_ptr,m_len,a_ptr,a_len)->i64 + omni_alloc）\n;; 构建：wat2wasm logic.wat -o logic.wasm\n(module\n  (import "omni" "ping" (func $ping (result i32)))\n  (memory (export "memory") 1)\n  (global $alloc_ptr (mut i32) (i32.const 1024))\n  (func $alloc (export "omni_alloc") (param $n i32) (result i32)\n    (local $p i32)\n    (local.set $p (global.get $alloc_ptr))\n    (global.set $alloc_ptr (i32.add (global.get $alloc_ptr) (local.get $n)))\n    (local.get $p))\n  (data (i32.const 0) "{\\"echo\\":true}")\n  (func (export "call") (param $m_ptr i32) (param $m_len i32) (param $a_ptr i32) (param $a_len i32) (result i64)\n    (drop (call $ping))\n    (i64.or\n      (i64.extend_i32_u (i32.const 0))\n      (i64.shl (i64.extend_i32_u (i32.const 13)) (i64.const 32))))\n)\n`,
  );
}

if (kind === "js-logic" || kind === "l3-overlay") {
  mkdirSync(path.join(dir, "ui"), { recursive: true });
  const logicBody =
    kind === "js-logic"
      ? `function asObj(v) {\n  if (v && typeof v === "object") return v;\n  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }\n}\nfunction echo(args) {\n  var a = asObj(args);\n  return { echo: a.text || a || "" };\n}\nvar HANDLERS = { echo: echo };\nfunction call(method, argsJson) {\n  var handler = HANDLERS[String(method || "")];\n  if (!handler) throw new Error("UnknownMethod: " + method);\n  var result = handler(asObj(argsJson));\n  return typeof result === "string" ? result : JSON.stringify(result);\n}\nglobalThis.call = call;\n`
      : `function asObj(v) {\n  if (v && typeof v === "object") return v;\n  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }\n}\nfunction translate(args) {\n  var a = asObj(args);\n  return { source: a.text || "", target: "[demo] " + (a.text || "") };\n}\nvar HANDLERS = { translate: translate };\nfunction call(method, argsJson) {\n  var handler = HANDLERS[String(method || "")];\n  if (!handler) throw new Error("UnknownMethod: " + method);\n  var result = handler(asObj(argsJson));\n  return typeof result === "string" ? result : JSON.stringify(result);\n}\nglobalThis.call = call;\n`;
  writeFileSync(path.join(dir, "logic.js"), logicBody);
  writeFileSync(
    path.join(dir, "ui", "main.js"),
    `// 第三方动态前端入口：module.exports = definePlugin({ activate, deactivate })\nmodule.exports = definePlugin({\n  activate: async () => {},\n  deactivate: () => {},\n});\n`,
  );
  if (kind === "l3-overlay") {
    writeFileSync(
      path.join(dir, "ui", "index.html"),
      `<div>\n  <div class="omni-toolbar">\n    <button id="go" class="omni">执行</button>\n    <span id="status" class="omni-status"></span>\n  </div>\n  <div class="omni-muted" style="margin-bottom:4px">原文</div>\n  <div id="src" class="omni-card" style="white-space:pre-wrap;min-height:40px">选区加载中…</div>\n  <div class="omni-muted" style="margin:10px 0 4px">结果</div>\n  <div id="dst" class="omni-card" style="white-space:pre-wrap;min-height:40px">…</div>\n  <script>\n    (async function () {\n      try {\n        var sel = await window.host.selectionGet();\n        document.getElementById("src").textContent = (sel && sel.text) || "(无选区)";\n      } catch (e) { document.getElementById("src").textContent = "选区读取失败: " + e; }\n      document.getElementById("go").onclick = async function () {\n        document.getElementById("status").textContent = "执行中…";\n        try {\n          var r = await window.host.invoke("translate", { text: document.getElementById("src").textContent });\n          document.getElementById("dst").textContent = JSON.stringify(r);\n          document.getElementById("status").textContent = "";\n        } catch (e) { document.getElementById("dst").textContent = "调用失败: " + e; document.getElementById("status").textContent = "失败"; }\n      };\n    })();\n  <\/script>\n</div>\n`,
    );
  }
}

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
function listItems(args) {
  return { items: [] };
}
function getItem(args) {
  return { id: args.id || "", content: "" };
}
var HANDLERS = {
  testConnection: testConnection,
  getServerInfo: getServerInfo,
  probeHealth: probeHealth,
  listItems: listItems,
  getItem: getItem
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

if (kind === "panel") {
  writeFileSync(
    path.join(dir, "logic.js"),
    `function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}
function testConnection(args) {
  if (!args.address) throw new Error("缺少面板地址");
  return { ok: true, hostname: String(args.address) };
}
function listDatabases() { return { items: [] }; }
function createDatabase() { return { ok: true }; }
function deleteDatabase() { return { ok: true }; }
function emptyList() { return { items: [] }; }
function ok() { return { ok: true }; }
function getDashboard(args) {
  return {
    hostname: String(args.address || "panel"),
    os: "linux",
    cpuCores: 1,
    currentInfo: { cpuUsedPercent: 1, memoryTotal: 1, memoryUsed: 0, memoryAvailable: 1, load1: 0, load5: 0, load15: 0 }
  };
}
var HANDLERS = {
  testConnection: testConnection,
  getDashboard: getDashboard,
  listDatabases: listDatabases,
  createDatabase: createDatabase,
  deleteDatabase: deleteDatabase,
  listWebsites: emptyList,
  setWebsiteStatus: ok,
  deleteWebsite: ok,
  listCertificates: emptyList,
  deleteCertificate: ok,
  listCronjobs: emptyList,
  setCronjobStatus: ok,
  runCronjob: ok,
  deleteCronjob: ok,
  listApps: emptyList,
  listInstalledApps: emptyList
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

if (kind === "importer") {
  writeFileSync(
    path.join(dir, "logic.js"),
    `function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}
function fetchTargets(args) {
  var base = String(args.baseUrl || args.address || "").trim();
  if (!base) throw new Error("缺少地址");
  var host = base;
  if (host.indexOf("://") >= 0) host = host.slice(host.indexOf("://") + 3);
  var slash = host.indexOf("/");
  if (slash >= 0) host = host.slice(0, slash);
  if (!host) host = "imported.local";
  return {
    targets: [{
      pluginId: globalThis.__omniPluginId || "",
      remoteId: "imported-" + host,
      remoteKind: "ssh",
      name: String(args.name || host),
      config: { host: host, port: 22, user: "root" }
    }]
  };
}
var HANDLERS = { fetchTargets: fetchTargets };
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

if (kind === "cloud") {
  writeFileSync(
    path.join(dir, "logic.js"),
    `function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}
function testAccount(args) {
  if (!args.accessKeyId || !args.accessKeySecret) throw new Error("缺少 AccessKey");
  return "ok";
}
function listRegions(args) {
  return { items: (args.regions || []).map(function (id) { return { regionId: id, localName: id }; }) };
}
function getAccount(args) {
  return { accountId: args.accessKeyId || "", displayName: args.accessKeyId || "" };
}
function listResources() { return { items: [] }; }
function getResource(args) {
  return { id: args.resourceId || "", name: args.resourceId || "", capability: args.capability || "", fields: {} };
}
function invokeAction() { return { ok: true }; }
function getMetrics() { return { items: [] }; }
function queryLogs() { return { items: [], nextToken: "" }; }
var HANDLERS = {
  testAccount: testAccount,
  listRegions: listRegions,
  getAccount: getAccount,
  listResources: listResources,
  getResource: getResource,
  invokeAction: invokeAction,
  getMetrics: getMetrics,
  queryLogs: queryLogs
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

if (engineSidecar) {
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  mkdirSync(path.join(dir, "src-agent-rs", "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "bin", "agent.mjs"),
    '#!/usr/bin/env node\n' +
    '/**\n' +
    ' * DBX sidecar 参考 agent（Node）：stdin/stdout 一行一条 JSON-RPC。\n' +
    ' * 协议见 docs/plugins/sidecar-dbx.md；自测：node scripts/check-dbx-agent.mjs <dir>/bin/agent.mjs\n' +
    ' * 把 TODO 处的桩换成真实驱动即可上线；想用 Rust 见 src-agent-rs/。\n' +
    ' */\n' +
    'import readline from "node:readline";\n' +
    'var ENGINE = ' + JSON.stringify(name) + ';\n' +
    'function canonical(method) {\n' +
    '  switch (method) {\n' +
    '    case "executeQuery": return "execute";\n' +
    '    case "listTables": return "list_tables";\n' +
    '    case "getColumns": return "describe_table";\n' +
    '    case "getTableDdl": return "show_create_table";\n' +
    '    case "listDatabases": return "list_databases";\n' +
    '    case "listSchemas": return "list_schemas";\n' +
    '    case "testConnection":\n' +
    '    case "test_connection": return "version";\n' +
    '    default: return method;\n' +
    '  }\n' +
    '}\n' +
    'function reply(id, result) {\n' +
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id, result: result }) + "\\n");\n' +
    '}\n' +
    'function fail(id, message) {\n' +
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id, error: { code: -32000, message: message } }) + "\\n");\n' +
    '}\n' +
    'var connected = false;\n' +
    'var rl = readline.createInterface({ input: process.stdin });\n' +
    'rl.on("line", function (line) {\n' +
    '  var trimmed = line.trim();\n' +
    '  if (!trimmed) return;\n' +
    '  var req;\n' +
    '  try { req = JSON.parse(trimmed); } catch (err) { fail(0, "请求不是合法 JSON-RPC: " + err); return; }\n' +
    '  var id = (req.id === undefined || req.id === null) ? 0 : req.id;\n' +
    '  var method = canonical(req.method);\n' +
    '  if (method === "handshake") { reply(id, { protocolVersion: 1, engine: ENGINE, capabilities: ["connect", "query", "preview", "metadata", "extra"] }); return; }\n' +
    '  if (method === "connect") { connected = true; reply(id, { ok: true }); return; }\n' +
    '  if (method === "disconnect") { connected = false; reply(id, { ok: true, bye: true }); rl.close(); return; }\n' +
    '  if (!connected) { fail(id, "尚未 connect"); return; }\n' +
    '  var params = (req.params && typeof req.params === "object") ? req.params : {};\n' +
    '  switch (method) {\n' +
    '    case "version": reply(id, ENGINE + " 0.1.0"); break;\n' +
    '    case "list_tables": reply(id, ["DEMO"]); break;\n' +
    '    case "list_databases":\n' +
    '    case "list_schemas": reply(id, ["DEFAULT"]); break;\n' +
    '    case "describe_table": reply(id, [{ name: "ID", type: "INTEGER" }]); break;\n' +
    '    case "show_create_table": reply(id, "CREATE TABLE DEMO (ID INTEGER)"); break;\n' +
    '    case "execute": reply(id, { columns: ["X"], rows: [[1]], rowsAffected: 0 }); break;\n' +
    '    case "preview": reply(id, { columns: ["X"], rows: [[1]], rowsAffected: 0 }); break;\n' +
    '    default: fail(id, "未知方法: " + method);\n' +
    '  }\n' +
    '  void params;\n' +
    '});\n',
  );
  writeFileSync(
    path.join(dir, "src-agent-rs", "Cargo.toml"),
    '[package]\nname = "' + name + '-agent"\nversion = "0.1.0"\nedition = "2021"\n\n'
    + '[[bin]]\nname = "' + name + '-agent"\npath = "src/main.rs"\n\n'
    + '[dependencies]\ntokio = { version = "1", features = ["io-util", "io-std", "macros", "rt-multi-thread"] }\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\n',
  );
  writeFileSync(
    path.join(dir, "src-agent-rs", "src", "main.rs"),
    '//! DBX sidecar 参考 agent（Rust，自包含：tokio + serde_json）。\n'
    + '//! 协议见 docs/plugins/sidecar-dbx.md。\n'
    + '//! 上线步骤：实现 connect/execute 等 TODO → cargo build --release →\n'
    + '//! 把产物拷为插件包 bin/' + name + '（Windows 下 bin/' + name + '.exe）→\n'
    + '//! plugin.json entry.driver 改过去 → node scripts/check-dbx-agent.mjs 验证 → pack。\n'
    + 'use serde_json::{Value, json};\n'
    + 'use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};\n'
    + 'const ENGINE: &str = "' + name + '";\n'
    + 'fn canonical(method: &str) -> &str {\n'
    + '    match method {\n'
    + '        "executeQuery" => "execute",\n'
    + '        "listTables" => "list_tables",\n'
    + '        "getColumns" => "describe_table",\n'
    + '        "getTableDdl" => "show_create_table",\n'
    + '        "listDatabases" => "list_databases",\n'
    + '        "listSchemas" => "list_schemas",\n'
    + '        "testConnection" | "test_connection" => "version",\n'
    + '        other => other,\n'
    + '    }\n'
    + '}\n'
    + 'fn ok(id: &Value, result: Value) -> String {\n'
    + '    serde_json::to_string(&json!({"jsonrpc":"2.0","id":id,"result":result})).unwrap_or_default()\n'
    + '}\n'
    + 'fn err(id: &Value, message: String) -> String {\n'
    + '    serde_json::to_string(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})).unwrap_or_default()\n'
    + '}\n'
    + '#[tokio::main]\n'
    + 'async fn main() {\n'
    + '    let stdin = tokio::io::stdin();\n'
    + '    let mut out = tokio::io::stdout();\n'
    + '    let mut lines = BufReader::new(stdin).lines();\n'
    + '    let mut connected = false;\n'
    + '    while let Ok(Some(line)) = lines.next_line().await {\n'
    + '        let trimmed = line.trim();\n'
    + '        if (trimmed.is_empty()) { continue; }\n'
    + '        let req: Value = match serde_json::from_str(trimmed) {\n'
    + '            Ok(v) => v,\n'
    + '            Err(e) => { let s = err(&Value::from(0), format!("请求不是合法 JSON-RPC: {e}")); out.write_all(s.as_bytes()).await.ok(); out.write_all(b"\\n").await.ok(); out.flush().await.ok(); continue; }\n'
    + '        };\n'
    + '        let id = req.get("id").cloned().unwrap_or(Value::from(0));\n'
    + '        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");\n'
    + '        let method = canonical(method);\n'
    + '        let line_out = match method {\n'
    + '            "handshake" => ok(&id, json!({"protocolVersion":1,"engine":ENGINE,"capabilities":["connect","query","preview","metadata","extra"]})),\n'
    + '            "connect" => { connected = true; ok(&id, json!({"ok":true})) }\n'
    + '            "disconnect" => { connected = false; let s = ok(&id, json!({"ok":true,"bye":true})); out.write_all(s.as_bytes()).await.ok(); out.write_all(b"\\n").await.ok(); out.flush().await.ok(); break; }\n'
    + '            _ if (!connected) => err(&id, "尚未 connect".into()),\n'
    + '            "version" => ok(&id, json!(format!("{ENGINE} 0.1.0"))),\n'
    + '            "list_tables" => ok(&id, json!(["DEMO"])),\n'
    + '            "list_databases" | "list_schemas" => ok(&id, json!(["DEFAULT"])),\n'
    + '            "describe_table" => ok(&id, json!([{"name":"ID","type":"INTEGER"}])),\n'
    + '            "show_create_table" => ok(&id, json!("CREATE TABLE DEMO (ID INTEGER)")),\n'
    + '            "execute" | "preview" => ok(&id, json!({"columns":["X"],"rows":[[1]],"rowsAffected":0})),\n'
    + '            other => err(&id, format!("未知方法: {other}")),\n'
    + '        };\n'
    + '        out.write_all(line_out.as_bytes()).await.ok();\n'
    + '        out.write_all(b"\\n").await.ok();\n'
    + '        out.flush().await.ok();\n'
    + '    }\n'
    + '}\n',
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

完整合同见仓库 \`docs/plugins/README.md\`。打包前先跑 \`node scripts/validate-plugin.mjs plugins-custom/${name}\`。

- 与内置同 id 的包会被拒绝覆盖。
- engine-sidecar：\`bin/agent.mjs\` 开箱可跑（\`node scripts/check-dbx-agent.mjs plugins-custom/${name}/bin/agent.mjs\` 先变绿，再换真实驱动）；Rust 版在 \`src-agent-rs/\`，\`cargo build --release\` 后把产物拷为 \`bin/${name}\`（Windows 为 \`bin/${name}.exe\`）并把 \`entry.driver\` 改过去。协议见 \`docs/plugins/sidecar-dbx.md\`。多平台发布时每个平台打各自的包（\`platforms\` 声明对应平台）。
- module：启用后侧栏出现入口；实现 \`listItems({ capabilityId, ... })\`，用 \`detail\` 选通用壳（none / editor / form / kv / children / logs / metrics / facts / tree）。
- cloud：启用后出现在云账户对话框；实现 \`testAccount\` / \`listResources\` 等即可走宿主云工作台。签厂商 API 用 \`host.hmac(JSON.stringify({ alg, key, data, encoding }))\`。
- panel：启用后出现在服务器「添加面板」；\`testConnection\` 必做。点名 \`panelTabs\` 时实现对应 \`list*\`；overview 要实现 \`getDashboard\`。声明 create 必须带 formFields，Host 用通用表单。
- importer：启用后出现在导入向导；实现 \`fetchTargets\`，返回 \`{ targets: ImportCandidate[] }\`（至少一条可导入候选）。
- addon：L1 启动条前缀；需要 Overlay / 菜单时再补 \`overlays\` / \`menus\`。
`,
);

console.log(`已生成 ${path.relative(root, dir)}`);
console.log(`打包: cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-custom/${name} ${name}.omni-plugin`);
