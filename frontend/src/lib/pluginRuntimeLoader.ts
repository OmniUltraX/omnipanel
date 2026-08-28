import type { PluginHost, PluginModule } from "@omnipanel/plugin-sdk";
import { getPluginManifest } from "./pluginManifests";
import everythingAddon from "../../../plugins/addon-everything/src/index";
import panel1Panel from "../../../plugins/panel-1panel/src/index";
import panelBt from "../../../plugins/panel-bt/src/index";

/**
 * 第一方插件运行时装载器（阶段 A 过渡形态：静态 import map）。
 * 唯一允许 import `plugins/*` 逻辑源的宿主模块；阶段 B 换磁盘包/WASM 装载时仅替换本文件，合同不变。
 *
 * 生命周期：`syncPluginLifecycles` 按 enabled+activated 差量驱动
 * activate/deactivate（先卸后启）。需要 TS 登记的贡献（面板探测等）在 activate 内完成；
 * importer 只读清单 `contributes.importers[]`，不必进入本表。
 */

type LifecycleItem = { id: string; enabled: boolean; activated: boolean };

const PLUGIN_MODULES: Record<string, PluginModule> = {
  "omni.addon.everything": everythingAddon,
  "omni.panel.1panel": panel1Panel,
  "omni.panel.bt": panelBt,
};

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
  const next = new Set(
    items
      .filter((item) => item.enabled && item.activated && PLUGIN_MODULES[item.id])
      .map((item) => item.id),
  );

  for (const id of [...activeIds].sort()) {
    if (next.has(id)) continue;
    activeIds.delete(id);
    try {
      PLUGIN_MODULES[id]?.deactivate?.();
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
      await PLUGIN_MODULES[id].activate({ host, manifest });
      activeIds.add(id);
    } catch (err) {
      console.error(`[plugin-runtime] activate ${id} 失败`, err);
    }
  }
}

/** 仅测试：重置生命周期状态。 */
export function resetPluginLifecycleForTests(): void {
  for (const id of [...activeIds]) {
    try {
      PLUGIN_MODULES[id]?.deactivate?.();
    } catch {
      /* ignore */
    }
  }
  activeIds.clear();
  catalogReady = false;
}
