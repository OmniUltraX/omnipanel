#!/usr/bin/env node
/**
 * validate-plugin — 第三方插件包校验（开发期门禁）。
 *
 *   node scripts/validate-plugin.mjs <plugin-dir> [plugin-dir...]
 *   node scripts/validate-plugin.mjs plugins-samples
 *
 * 目录下有 plugin.json 则校验该包；否则扫描直接子目录。
 * 检查：清单字段、kind 合同、入口文件、methods 引用、L2 logic.js 可装载。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkPath = path.join(root, "packages", "plugin-sdk", "src", "index.ts");

function extractZodEnum(src, name) {
  const match = src.match(new RegExp(`export const ${name} = z\\.enum\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`));
  if (!match) throw new Error(`无法从 plugin-sdk 提取 ${name}`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

const sdkSrc = readFileSync(sdkPath, "utf8");
const KINDS = extractZodEnum(sdkSrc, "pluginKindSchema");
const PERMISSIONS = extractZodEnum(sdkSrc, "pluginPermissionSchema");
const PLATFORMS = extractZodEnum(sdkSrc, "pluginPlatformSchema");
const RUNTIMES = new Set(["inproc", "sidecar", "http"]);

function collectTargets(args) {
  const inputs = args.length > 0 ? args : ["plugins-samples"];
  const dirs = [];
  for (const raw of inputs) {
    const abs = path.resolve(process.cwd(), raw);
    if (!existsSync(abs)) {
      console.error(`[validate-plugin] 不存在: ${raw}`);
      process.exit(2);
    }
    if (existsSync(path.join(abs, "plugin.json"))) {
      dirs.push(abs);
      continue;
    }
    if (!statSync(abs).isDirectory()) {
      console.error(`[validate-plugin] 不是目录: ${raw}`);
      process.exit(2);
    }
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(abs, entry.name);
      if (existsSync(path.join(child, "plugin.json"))) dirs.push(child);
    }
  }
  return dirs;
}

function rel(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function isSafeRel(p) {
  return typeof p === "string" && p.trim() && !p.startsWith("/") && !p.split(/[\\/]/).includes("..");
}

function methodNames(raw) {
  return new Set(
    (Array.isArray(raw.methods) ? raw.methods : [])
      .filter((m) => m && typeof m.name === "string")
      .map((m) => m.name),
  );
}

function pushMissingMethods(errors, have, needed, label) {
  for (const name of needed) {
    if (!have.has(name)) errors.push(`${label} 缺少 methods[].name=${name}`);
  }
}

function referencedMethods(raw) {
  const names = [];
  for (const cap of raw.contributes?.module?.capabilities ?? []) {
    for (const key of ["listMethod", "getMethod", "historyMethod", "childListMethod"]) {
      if (typeof cap?.[key] === "string" && cap[key].trim()) names.push(cap[key].trim());
    }
    for (const action of cap?.actions ?? []) {
      if (typeof action?.method === "string" && action.method.trim()) names.push(action.method.trim());
    }
  }
  for (const tab of raw.contributes?.ui?.panelTabs ?? []) {
    if (typeof tab?.listMethod === "string" && tab.listMethod.trim()) names.push(tab.listMethod.trim());
    for (const action of tab?.actions ?? []) {
      if (typeof action?.method === "string" && action.method.trim()) names.push(action.method.trim());
    }
  }
  for (const importer of raw.contributes?.importers ?? []) {
    if (typeof importer?.fetchMethod === "string" && importer.fetchMethod.trim()) {
      names.push(importer.fetchMethod.trim());
    }
  }
  for (const tool of raw.contributes?.ai?.tools ?? []) {
    if (tool?.execKind === "plugin" && typeof tool?.name === "string") names.push(tool.name);
  }
  return names;
}

function kindErrors(raw, dir) {
  const errors = [];
  const have = methodNames(raw);
  const kind = raw.kind;
  const logic = raw.entry?.logic;
  const driver = raw.entry?.driver;

  if (kind === "engine") {
    const engineKey = raw.contributes?.ui?.connectionForm?.engineKey;
    if (typeof engineKey !== "string" || !engineKey.trim()) {
      errors.push("engine 必须声明 contributes.ui.connectionForm.engineKey");
    }
    if (raw.runtime === "sidecar" && !driver) {
      errors.push("runtime=sidecar 必须声明 entry.driver");
    }
  }
  if (kind === "panel" && logic) {
    pushMissingMethods(errors, have, ["testConnection"], "panel");
    const tabs = raw.contributes?.ui?.panelTabs ?? [];
    const tabIds = new Set(
      tabs.map((tab) => (tab && typeof tab.id === "string" ? tab.id.trim() : "")).filter(Boolean),
    );
    const tabListMethods = {
      databases: "listDatabases",
      websites: "listWebsites",
      certificates: "listCertificates",
      cronjobs: "listCronjobs",
      apps: "listApps",
    };
    for (const [tab, method] of Object.entries(tabListMethods)) {
      if (!tabIds.has(tab)) continue;
      const decl = tabs.find((item) => item && item.id === tab);
      const listMethod =
        typeof decl?.listMethod === "string" && decl.listMethod.trim()
          ? decl.listMethod.trim()
          : method;
      pushMissingMethods(errors, have, [listMethod], `panel tab ${tab}`);
    }
    if (tabIds.has("overview")) {
      pushMissingMethods(errors, have, ["getDashboard"], "panel tab overview");
    }
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object") continue;
      const tabId = typeof tab.id === "string" ? tab.id.trim() : "";
      for (const action of tab.actions ?? []) {
        if (!action || typeof action !== "object") continue;
        const isCreate =
          action.id === "create" ||
          (typeof action.method === "string" && /^create/i.test(action.method));
        if (!isCreate) continue;
        if (!Array.isArray(tab.formFields) || tab.formFields.length === 0) {
          errors.push(`panel tab ${tabId || "?"} 声明 create 必须带 formFields`);
        }
      }
    }
  }
  if (kind === "cloud" && logic) {
    pushMissingMethods(errors, have, ["testAccount", "listResources"], "cloud");
  }
  if (kind === "module" && logic && have.size === 0) {
    errors.push("module 有 entry.logic 时必须声明 methods[]");
  }
  if (kind === "importer") {
    const importers = raw.contributes?.importers;
    if (!Array.isArray(importers) || importers.length === 0) {
      errors.push("importer 必须声明 contributes.importers[]");
    }
  }
  if (kind === "theme") {
    const js = raw.contributes?.themes?.tokens?.js ?? raw.contributes?.themes?.js;
    if (js === true) errors.push("theme 禁止 js: true");
  }
  if (kind === "addon") {
    const c = raw.contributes ?? {};
    if (!c.launcher && !c.overlays?.length && !c.menus?.length && !c.ai?.tools?.length) {
      errors.push("addon 至少声明 launcher / overlays / menus / ai.tools 之一");
    }
  }

  if (logic) {
    if (!isSafeRel(logic) || !/\.(js|wasm)$/i.test(logic)) {
      errors.push("entry.logic 必须是相对路径的 .js / .wasm");
    } else if (!existsSync(path.join(dir, logic))) {
      // wasm 允许只提交 logic.wat 源码（构建出 logic.wasm 后再 pack）
      const watFallback =
        /\.wasm$/i.test(logic) &&
        existsSync(path.join(dir, logic.replace(/\.wasm$/i, ".wat")));
      if (!watFallback) errors.push(`缺少入口文件 ${logic}`);
    }
  }
  if (driver) {
    if (!isSafeRel(driver)) {
      errors.push("entry.driver 必须是相对路径且不含 ..");
    } else if (!existsSync(path.join(dir, driver))) {
      errors.push(`缺少入口文件 ${driver}`);
    }
  }
  const uiEntry = raw.entry?.ui;
  if (uiEntry) {
    if (!isSafeRel(uiEntry) || !/\.js$/i.test(uiEntry)) {
      errors.push("entry.ui 必须是相对路径的 .js");
    } else if (!existsSync(path.join(dir, uiEntry))) {
      errors.push(`缺少入口文件 ${uiEntry}`);
    }
  }
  for (const overlay of raw.contributes?.overlays ?? []) {
    const entry = overlay?.entry;
    if (typeof entry === "string" && entry.trim()) {
      if (!isSafeRel(entry)) errors.push(`overlays.entry 非法: ${entry}`);
      else if (!existsSync(path.join(dir, entry))) errors.push(`缺少 overlay 入口 ${entry}`);
    }
  }
  const icon = raw.contributes?.ui?.home?.icon;
  if (typeof icon === "string" && icon.trim()) {
    if (!isSafeRel(icon) || !/\.(svg|png)$/i.test(icon)) {
      errors.push("ui.home.icon 必须是相对路径 svg/png");
    } else if (!existsSync(path.join(dir, icon))) {
      errors.push(`缺少 ui.home.icon ${icon}`);
    }
  }

  for (const name of referencedMethods(raw)) {
    if (!have.has(name)) errors.push(`contributes 引用了未声明的 method: ${name}`);
  }
  return errors;
}

function baseErrors(raw) {
  const errors = [];
  if (typeof raw.id !== "string" || !raw.id.trim()) errors.push("id required");
  else if (!raw.id.includes(".")) errors.push("id 必须是反向域名（至少含一个 .）");
  if (typeof raw.version !== "string" || !raw.version.trim()) errors.push("version required");
  if (!KINDS.has(raw.kind)) errors.push(`kind 必须是 ${[...KINDS].join(" | ")}`);
  if (raw.permissions != null) {
    if (!Array.isArray(raw.permissions)) errors.push("permissions must be an array");
    else for (const p of raw.permissions) {
      if (!PERMISSIONS.has(p)) errors.push(`未知权限 ${p}`);
    }
  }
  if (raw.platforms != null) {
    if (!Array.isArray(raw.platforms)) errors.push("platforms must be an array");
    else for (const p of raw.platforms) {
      if (!PLATFORMS.has(p)) errors.push(`未知平台 ${p}`);
    }
  }
  if (raw.runtime != null && !RUNTIMES.has(raw.runtime)) {
    errors.push("runtime 必须是 inproc | sidecar | http");
  }
  if (raw.methods != null) {
    if (!Array.isArray(raw.methods)) errors.push("methods must be an array");
    else {
      const seen = new Set();
      for (const m of raw.methods) {
        if (!m || typeof m !== "object") {
          errors.push("methods[] 必须是对象");
          continue;
        }
        if (typeof m.name !== "string" || !m.name.trim()) errors.push("methods[].name required");
        else if (seen.has(m.name)) errors.push(`重复 method ${m.name}`);
        else seen.add(m.name);
        for (const p of m.permissions ?? []) {
          if (!PERMISSIONS.has(p)) errors.push(`method ${m.name} 未知权限 ${p}`);
        }
      }
    }
  }
  if (raw.minHostApi != null && (!Number.isInteger(raw.minHostApi) || raw.minHostApi < 1)) {
    errors.push("minHostApi 必须是正整数");
  }
  return errors;
}

function smokeLogic(dir, logicRel) {
  if (!logicRel || !/\.js$/i.test(logicRel)) return [];
  const file = path.join(dir, logicRel);
  if (!existsSync(file)) return [];
  const errors = [];
  const state = { value: "{}" };
  const stub = () => "";
  const host = {
    ping: () => "pong",
    hmac: stub,
    netFetch: () => JSON.stringify({ ok: true, items: [] }),
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
  const sandbox = { host, console, globalThis: {} };
  sandbox.globalThis = sandbox;
  try {
    runInContext(readFileSync(file, "utf8"), createContext(sandbox), { filename: file, timeout: 2000 });
  } catch (err) {
    return [`logic.js 装载失败: ${err instanceof Error ? err.message : err}`];
  }
  const call = sandbox.call ?? sandbox.globalThis?.call;
  if (typeof call !== "function") {
    errors.push("logic.js 必须提供 globalThis.call(method, argsJson)");
    return errors;
  }
  try {
    call("__omni_missing_method__", "{}");
    errors.push("logic.js 对未知 method 应抛 UnknownMethod");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UnknownMethod/i.test(msg)) {
      errors.push(`未知 method 错误应含 UnknownMethod，实际: ${msg}`);
    }
  }
  return errors;
}

function sidecarErrors(raw, dir) {
  if (raw.kind !== "engine" || raw.runtime !== "sidecar") return [];
  const driver = raw.entry?.driver;
  if (!driver || !/\.(mjs|js)$/i.test(driver)) return [];
  const agent = path.join(dir, driver);
  if (!existsSync(agent)) return [];
  const checker = path.join(root, "scripts", "check-dbx-agent.mjs");
  const args = [checker, agent];
  const engineKey = raw.contributes?.ui?.connectionForm?.engineKey;
  if (typeof engineKey === "string" && engineKey.trim()) {
    args.push("--engine", engineKey.trim());
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20000 });
  if (result.status !== 0) {
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return [`sidecar check-dbx-agent 失败${out ? `:\n${out}` : ""}`];
  }
  return [];
}

function validateDir(dir) {
  const file = path.join(dir, "plugin.json");
  const label = rel(dir);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { label, errors: [`plugin.json 不是合法 JSON (${err})`] };
  }
  const errors = [
    ...baseErrors(raw),
    ...kindErrors(raw, dir),
    ...smokeLogic(dir, raw.entry?.logic),
    ...sidecarErrors(raw, dir),
  ];
  return { label, errors };
}

const targets = collectTargets(process.argv.slice(2));
if (targets.length === 0) {
  console.error("用法: node scripts/validate-plugin.mjs <plugin-dir> [plugin-dir...]");
  console.error("  也可传入含多个子包的目录（如 plugins-samples）");
  process.exit(2);
}

let failed = 0;
for (const dir of targets) {
  const { label, errors } = validateDir(dir);
  if (errors.length > 0) {
    console.error(`[validate-plugin] ${label}:\n  - ${errors.join("\n  - ")}`);
    failed += 1;
  } else {
    console.log(`[validate-plugin] ok  ${label}`);
  }
}

if (failed > 0) {
  console.error(`[validate-plugin] ${failed}/${targets.length} 未通过`);
  process.exit(1);
}
console.log(`validate-plugin ok (${targets.length})`);
