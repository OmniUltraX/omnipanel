// 插件能力全链路实测（经 MCP 桥 execute_js → __TAURI__.invoke）
import fs from "node:fs";

const url = "ws://127.0.0.1:9223";
const ws = new WebSocket(url);
const timer = setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 30000);
const pending = new Map();
let stepNo = 0;
const results = [];

function ok(name, cond, detail = "") {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
  if (!cond) finish();
}

function normalize(v) {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* keep */ } }
  return v;
}

function call(tauriCmd, cmdArgs) {
  return new Promise((resolve) => {
    const id = "s" + ++stepNo;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, command: tauriCmd, args: cmdArgs ?? {} }));
  });
}

async function rawInvoke(tauriCmd, cmdArgs) {
  const script = `window.__TAURI__.core.invoke(${JSON.stringify(tauriCmd)}, ${JSON.stringify(cmdArgs ?? {})}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ __invokeErr: String(e && e.message || e) }))`;
  return normalize(await call("execute_js", { script }));
}

async function tryInvoke(tauriCmd, cmdArgs) {
  const r = await rawInvoke(tauriCmd, cmdArgs);
  if (r && r.__invokeErr) return { __ok: false, err: r.__invokeErr };
  return { __ok: true, r };
}

const APPDATA = process.env.APPDATA + "\\com.omnipanel.app\\plugins";

async function run() {
  const baseline = await rawInvoke("plugin_list");
  ok("A 基线 plugin_list = 10 内置", Array.isArray(baseline) && baseline.length === 10, `got ${baseline?.length}`);

  const inst = await tryInvoke("plugin_install_from_file", { path: process.env.TEMP + "\\opencode\\l1-starter.omni-plugin" });
  ok("B 安装 l1-starter", inst.__ok && inst.r?.source === "installed" && inst.r?.activated === true, JSON.stringify(inst.r ?? inst.err).slice(0, 120));
  ok("B2 磁盘目录已落盘", fs.existsSync(APPDATA + "\\omni.engine.l1-starter\\plugin.json"));

  const mans = await rawInvoke("plugin_manifests");
  const m = Array.isArray(mans) ? mans.find((x) => x.id === "omni.engine.l1-starter") : null;
  ok("C plugin_manifests 含已安装包", !!m && m.source === "installed", m ? `kind=${m.kind}` : "missing");

  const ping = await tryInvoke("plugin_invoke", { pluginId: "omni.engine.l1-starter", method: "l1_starter_ping", args: {} });
  ok("D L1 无逻辑包 → UnknownMethod 干净失败", ping.__ok === false && /未声明方法/.test(ping.err ?? ""), (ping.err ?? "").slice(0, 80));

  const denied = await tryInvoke("plugin_sandbox_net_fetch", { pluginId: "omni.addon.everything", specJson: JSON.stringify({ url: "https://example.com" }) });
  ok("E 沙箱 netFetch 缺权被拒", denied.__ok === false, (denied.err ?? "").slice(0, 90));

  const off = await rawInvoke("plugin_set_enabled", { pluginId: "omni.engine.l1-starter", enabled: false });
  ok("F1 禁用生效 enabled=false", off.enabled === false);
  const on = await rawInvoke("plugin_set_enabled", { pluginId: "omni.engine.l1-starter", enabled: true });
  ok("F2 重新启用 activated=true", on.enabled === true && on.activated === true);

  const inst3 = await tryInvoke("plugin_install_from_file", { path: process.env.TEMP + "\\opencode\\l3-translator.omni-plugin" });
  ok("G1 安装 l3-translator", inst3.__ok && inst3.r?.source === "installed", JSON.stringify(inst3.r ?? inst3.err).slice(0, 100));
  const asset = await tryInvoke("plugin_read_asset", { pluginId: "omni.addon.translator", relPath: "ui/index.html" });
  ok("G2 读取沙箱页面资产", asset.__ok && /pseudoTranslate/i.test(asset.r ?? ""), `len=${(asset.r ?? "").length}`);
  const evil = await tryInvoke("plugin_read_asset", { pluginId: "omni.addon.translator", relPath: "../l1-starter/plugin.json" });
  ok("G3 路径越界被拒", evil.__ok === false, (evil.err ?? "").slice(0, 60));

  const unl1 = await tryInvoke("plugin_uninstall", { pluginId: "omni.engine.l1-starter" });
  const unl3 = await tryInvoke("plugin_uninstall", { pluginId: "omni.addon.translator" });
  ok("H1 卸载 l1+l3 成功", unl1.__ok && unl3.__ok);
  const after = await rawInvoke("plugin_list");
  ok("H2 列表回到 10 内置", Array.isArray(after) && after.length === 10, `got ${after?.length}`);
  ok("H3 磁盘目录已清理", !fs.existsSync(APPDATA + "\\omni.engine.l1-starter") && !fs.existsSync(APPDATA + "\\omni.addon.translator"));

  const noUn = await tryInvoke("plugin_uninstall", { pluginId: "omni.engine.redis" });
  ok("I 内置插件拒绝卸载", noUn.__ok === false, (noUn.err ?? "").slice(0, 60));

  finish();
}

function finish() {
  clearTimeout(timer);
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== 插件能力实测：${pass}/${results.length} 通过 ===`);
  try { ws.close(); } catch {}
  process.exit(pass === results.length ? 0 : 1);
}

ws.onopen = () => { console.log("[WS connected]"); run().catch((e) => { console.error("RUNNER ERR", e); finish(); }); };
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const fn = pending.get(msg.id);
  if (!fn) return;
  pending.delete(msg.id);
  fn(msg.success === false ? { __invokeErr: String(msg.error) } : msg.data);
  if (msg.success === false) console.error("BACKEND ERR:", msg.id, msg.error);
};
ws.onerror = () => { console.error("WS error"); finish(); };
