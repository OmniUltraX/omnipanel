import { definePlugin, type PluginHost, type PluginModule } from "@omnipanel/plugin-sdk";
import { getPluginManifest } from "./pluginManifests";
import { syncModuleLauncherProviders } from "./moduleLauncher";
import everythingAddon from "../../../plugins/addon-everything/src/index";
import panel1Panel from "../../../plugins/panel-1panel/src/index";
import panelBt from "../../../plugins/panel-bt/src/index";
import moduleNacos from "../../../plugins/module-nacos/src/index";

/**
 * 第一方插件运行时装载器 + 第三方磁盘包动态装载（双源）。
 * 唯一允许 import `plugins/*` 逻辑源的宿主模块；磁盘包经 `plugin_read_asset(ui/main.js)`
 * 沙箱求值后注册，与第一方同一条差量 activate/deactivate 合同。
 *
 * 生命周期：`syncPluginLifecycles` 按 enabled+activated 差量驱动
 * activate/deactivate（先卸后启）。需要 TS 登记的贡献（面板探测、L2 driver 等）
 * 在 activate 内完成；importer 只读清单 `contributes.importers[]`，不必进入本表。
 */

type LifecycleItem = { id: string; enabled: boolean; activated: boolean };

const PLUGIN_MODULES: Record<string, PluginModule> = {
  "omni.addon.everything": everythingAddon,
  "omni.panel.1panel": panel1Panel,
  "omni.panel.bt": panelBt,
  "omni.module.nacos": moduleNacos,
};

/** 第三方动态模块缓存（磁盘包 ui/main.js 求值结果）。 */
const DYNAMIC_MODULES: Record<string, PluginModule> = {};
/** 动态入口加载失败的插件（降级为 L1，不再重试直到 reset）。 */
const DYNAMIC_FAILED = new Set<string>();

export type PluginAssetReader = (pluginId: string, relPath: string) => Promise<string>;

let assetReader: PluginAssetReader | null = null;

/** 注入磁盘资产读取器（默认走 IPC `plugin_read_asset`，测试可注入内存实现）。 */
export function setPluginAssetReader(reader: PluginAssetReader | null): void {
  assetReader = reader;
}

async function defaultAssetReader(pluginId: string, relPath: string): Promise<string> {
  const { commands } = await import("../ipc/bindings");
  const { unwrapCommand } = await import("../ipc/result");
  return unwrapCommand(commands.pluginReadAsset(pluginId, relPath));
}

function getAssetReader(): PluginAssetReader {
  return assetReader ?? defaultAssetReader;
}

/**
 * 沙箱求值第三方前端入口。
 * 约定：`ui/main.js` 为 CommonJS/IIFE 文本，可使用 `definePlugin`、`host`、`manifest`、
 * `module`/`exports`；返回或导出 `{activate, deactivate?}` 即为合法模块。
 * 单插件失败只记 `unsupported_reason=ui.invalid_entry`，不抛到外层。
 */
export function evaluateDynamicPluginModule(
  code: string,
  opts: { host: PluginHost; manifest: unknown },
): PluginModule | null {
  if (!code || code.length > 512 * 1024) return null;
  try {
    const moduleObj: { exports?: unknown } = {};
    const fn = new Function(
      "module",
      "exports",
      "definePlugin",
      "host",
      "manifest",
      `${code}\n;return (typeof module !== "undefined" && module.exports && module.exports.activate ? module.exports : undefined);`,
    ) as (...args: unknown[]) => unknown;
    const returned = fn(moduleObj, {}, definePlugin, opts.host, opts.manifest);
    const candidate = (returned ?? (moduleObj as { exports?: unknown }).exports) as Partial<PluginModule> | null;
    // 兼容直接 `return {activate}` 与 `module.exports = definePlugin({...})` 两种写法
    if (candidate && typeof (candidate as PluginModule).activate === "function") {
      return candidate as PluginModule;
    }
    // 兜底：尝试把整体当表达式求值（支持末尾 `definePlugin({...})`）
    try {
      const expr = new Function(
        "definePlugin",
        "host",
        "manifest",
        `"use strict";return (${code});`,
      ) as (...args: unknown[]) => unknown;
      const value = expr(definePlugin, opts.host, opts.manifest) as Partial<PluginModule> | null;
      if (value && typeof (value as PluginModule).activate === "function") {
        return value as PluginModule;
      }
    } catch {
      /* ignore expression fallback */
    }
    return null;
  } catch {
    return null;
  }
}

async function loadDynamicModule(
  id: string,
  uiEntry: string,
  host: PluginHost,
  manifest: unknown,
): Promise<PluginModule | null> {
  if (DYNAMIC_MODULES[id]) return DYNAMIC_MODULES[id];
  if (DYNAMIC_FAILED.has(id)) return null;
  try {
    const code = await getAssetReader()(id, uiEntry);
    const mod = evaluateDynamicPluginModule(code, { host, manifest });
    if (!mod) {
      console.error(`[plugin-runtime] ${id} unsupported_reason=ui.invalid_entry`);
      DYNAMIC_FAILED.add(id);
      return null;
    }
    DYNAMIC_MODULES[id] = mod;
    return mod;
  } catch (err) {
    console.error(`[plugin-runtime] load dynamic ${id} 失败`, err);
    DYNAMIC_FAILED.add(id);
    return null;
  }
}

let catalogReady = false;
const activeIds = new Set<string>();

// 惰性加载：避免宿主 UI store 链进入 Loader 静态依赖图（测试环境尤需封闭）。
let hostModulePromise: Promise<typeof import("./pluginHost")> | null = null;
async function defaultHostFactory(pluginId: string): Promise<PluginHost> {
  hostModulePromise ??= import("./pluginHost");
  return (await hostModulePromise).createPluginHost(pluginId);
}

export type PluginHostFactory = (pluginId: string) => Promise<PluginHost>;

/** 幂等：确保插件模块目录就绪（登记本身发生在 activate）。 */
export function ensurePluginContributionsLoaded(): void {
  catalogReady = true;
}

export function isPluginCatalogReady(): boolean {
  return catalogReady;
}

/** 差量同步：对新增激活执行 activate，对移除激活执行 deactivate（先卸后启）。 */
export async function syncPluginLifecycles(
  items: LifecycleItem[],
  hostFactory: PluginHostFactory = defaultHostFactory,
): Promise<void> {
  syncModuleLauncherProviders(items);
  const next = new Set(
    items.filter((item) => item.enabled && item.activated).map((item) => item.id),
  );

  for (const id of [...activeIds].sort()) {
    if (next.has(id)) continue;
    activeIds.delete(id);
    try {
      PLUGIN_MODULES[id]?.deactivate?.();
      DYNAMIC_MODULES[id]?.deactivate?.();
    } catch (err) {
      console.error(`[plugin-runtime] deactivate ${id} 失败`, err);
    }
  }

  for (const id of [...next].sort()) {
    if (activeIds.has(id)) continue;
    const manifest = getPluginManifest(id);
    if (!manifest) continue;
    try {
      const host = await hostFactory(id);
      const staticMod = PLUGIN_MODULES[id];
      if (staticMod) {
        await staticMod.activate({ host, manifest });
        activeIds.add(id);
        continue;
      }
      // 第三方动态路径：无 entry.ui 视为纯 L1，无需 activate
      const uiEntry =
        (manifest as unknown as { entry?: { ui?: unknown } }).entry?.ui ?? null;
      if (typeof uiEntry !== "string" || !uiEntry.trim()) continue;
      const dynamicMod = await loadDynamicModule(id, uiEntry.trim(), host, manifest);
      if (!dynamicMod) continue;
      await dynamicMod.activate({ host, manifest });
      activeIds.add(id);
    } catch (err) {
      console.error(`[plugin-runtime] activate ${id} 失败`, err);
    }
  }
}

/** 仅测试：重置生命周期状态。 */
export function resetPluginLifecycleForTests(): void {
  syncModuleLauncherProviders([]);
  for (const id of [...activeIds]) {
    try {
      PLUGIN_MODULES[id]?.deactivate?.();
      DYNAMIC_MODULES[id]?.deactivate?.();
    } catch {
      /* ignore */
    }
  }
  activeIds.clear();
  for (const key of Object.keys(DYNAMIC_MODULES)) delete DYNAMIC_MODULES[key];
  DYNAMIC_FAILED.clear();
  assetReader = null;
  catalogReady = false;
}
