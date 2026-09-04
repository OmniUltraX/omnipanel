#!/usr/bin/env node
/**
 * installed-pack smoke — 第三方样板主路径（Node，不上 Tauri UI）。
 *
 *   node scripts/smoke-plugin-samples.mjs
 *
 * 断言：logic.js 可装载；未知 method 抛 UnknownMethod；
 * panel 注入 apiKey 后测连/创建/列表非空；importer 产出可导入候选；
 * 监控第三方路径不再 else 掉进宝塔客户端。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = path.join(root, "plugins-samples");
const errors = [];

function fail(msg) {
  errors.push(msg);
  console.error(`[smoke] FAIL ${msg}`);
}

function ok(msg) {
  console.log(`[smoke] ok  ${msg}`);
}

function loadLogic(dir, logicRel, host) {
  const file = path.join(dir, logicRel);
  const sandbox = { host, console, globalThis: {} };
  sandbox.globalThis = sandbox;
  runInContext(readFileSync(file, "utf8"), createContext(sandbox), { filename: file, timeout: 3000 });
  const call = sandbox.call ?? sandbox.globalThis?.call;
  if (typeof call !== "function") throw new Error("缺少 globalThis.call");
  return call;
}

function parseResult(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw || "{}"));
  } catch {
    return {};
  }
}

function makeHost(netFetch) {
  const state = { value: "{}" };
  const stub = () => "";
  return {
    ping: () => "pong",
    hmac: stub,
    netFetch: netFetch ?? (() => JSON.stringify({ ok: true })),
    fsRead: stub,
    vaultGet: stub,
    vaultHas: () => false,
    vaultPut: stub,
    vaultDelete: stub,
    connectionUpsert: stub,
    stateGet: () => state.value,
    stateSet: (payload) => {
      state.value = String(payload ?? "{}");
      return "";
    },
    invoke: stub,
  };
}

function smokePanel(dir, raw) {
  const store = { websites: [] };
  const fetches = [];
  const host = makeHost((specJson) => {
    const spec = JSON.parse(String(specJson || "{}"));
    fetches.push(spec);
    const url = String(spec.url || "");
    const method = String(spec.method || "GET").toUpperCase();
    if (url.endsWith("/health")) return JSON.stringify({ ok: true });
    if (url.endsWith("/websites") && method === "POST") {
      const body = JSON.parse(String(spec.body || "{}"));
      store.websites.push({
        id: store.websites.length + 1,
        name: body.name,
        domain: body.domain,
      });
      return JSON.stringify({ ok: true });
    }
    if (url.endsWith("/websites")) return JSON.stringify({ items: store.websites });
    if (url.endsWith("/dashboard")) {
      return JSON.stringify({
        hostname: "fixture",
        cpuCores: 2,
        currentInfo: { cpuUsedPercent: 1, memoryTotal: 1, memoryUsed: 0, memoryAvailable: 1 },
      });
    }
    return JSON.stringify({ ok: true, items: [] });
  });
  const call = loadLogic(dir, raw.entry.logic, host);
  const creds = {
    address: "https://fixture.panel.local",
    apiKey: "injected-key",
    connectionId: "conn-1",
  };
  try {
    call("testConnection", JSON.stringify({ address: creds.address, apiKey: "" }));
    fail(`${path.basename(dir)} testConnection 空 apiKey 不应成功`);
  } catch {
    ok(`${path.basename(dir)} 拒绝空 apiKey`);
  }
  const ping = parseResult(call("testConnection", JSON.stringify(creds)));
  if (ping.ok !== true) fail(`${path.basename(dir)} testConnection 失败`);
  else ok(`${path.basename(dir)} testConnection`);
  if (!fetches.some((item) => String(item.headers?.Authorization || "").includes("injected-key"))) {
    fail(`${path.basename(dir)} netFetch 未带上注入的 apiKey`);
  } else {
    ok(`${path.basename(dir)} netFetch 带 apiKey`);
  }
  call("createWebsite", JSON.stringify({ ...creds, name: "demo", domain: "demo.local" }));
  const listed = parseResult(call("listWebsites", JSON.stringify(creds)));
  const items = Array.isArray(listed) ? listed : listed.items;
  if (!Array.isArray(items) || items.length === 0) {
    fail(`${path.basename(dir)} createWebsite 后 listWebsites 仍为空`);
  } else {
    ok(`${path.basename(dir)} 创建后列表非空 (${items.length})`);
  }
  const dash = parseResult(call("getDashboard", JSON.stringify(creds)));
  if (!dash.hostname && !dash.currentInfo) fail(`${path.basename(dir)} getDashboard 形状不对`);
  else ok(`${path.basename(dir)} getDashboard`);
}

function smokeImporter(dir, raw) {
  const call = loadLogic(dir, raw.entry.logic, makeHost());
  const result = parseResult(
    call(
      "fetchTargets",
      JSON.stringify({ baseUrl: "https://starter.example", token: "tok", name: "demo" }),
    ),
  );
  const targets = result.targets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) {
    fail(`${path.basename(dir)} fetchTargets 必须产出可导入候选`);
    return;
  }
  const first = targets[0];
  if (!first.remoteId || !first.remoteKind || !first.name) {
    fail(`${path.basename(dir)} 候选缺少 remoteId/remoteKind/name`);
  } else {
    ok(`${path.basename(dir)} fetchTargets ${targets.length} 条`);
  }
}

function assertNoBtElse() {
  const file = path.join(root, "frontend", "src", "components", "server", "ServerMonitorTab.tsx");
  const src = readFileSync(file, "utf8").replace(/\s+/g, " ");
  if (/createBtPanelClient|createOnePanelClient/.test(src)) {
    fail("ServerMonitorTab 不得直接调用面板客户端");
  } else {
    ok("监控不走第一方面板客户端");
  }
  if (/isBtPanelService|isOnePanelService/.test(src)) {
    fail("ServerMonitorTab 不得按厂商 ID 分叉");
  } else if (!/getPanelDriver/.test(src)) {
    fail("ServerMonitorTab 必须走 getPanelDriver");
  } else {
    ok("监控只认 getPanelDriver");
  }
}

assertNoBtElse();

for (const entry of readdirSync(samples, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(samples, entry.name);
  const manifestPath = path.join(dir, "plugin.json");
  if (!existsSync(manifestPath)) continue;
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!raw.entry?.logic) continue;
  try {
    const call = loadLogic(dir, raw.entry.logic, makeHost());
    try {
      call("__omni_missing_method__", "{}");
      fail(`${entry.name} 未知 method 应抛 UnknownMethod`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UnknownMethod/i.test(msg)) fail(`${entry.name} 未知 method 错误应含 UnknownMethod`);
      else ok(`${entry.name} UnknownMethod`);
    }
    if (raw.kind === "panel") smokePanel(dir, raw);
    if (raw.kind === "importer") smokeImporter(dir, raw);
  } catch (err) {
    fail(`${entry.name} 装载失败: ${err instanceof Error ? err.message : err}`);
  }
}

if (errors.length > 0) {
  console.error(`[smoke] ${errors.length} 项未通过`);
  process.exit(1);
}
console.log("plugin-samples smoke ok");
