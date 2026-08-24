import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { commands, type PluginListItem } from "../ipc/bindings";
import { PLUGIN_CHANGED } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import {
  ensurePluginContributionsLoaded,
  syncPluginLifecycles,
} from "../lib/pluginRuntimeLoader";
import { setInstalledPluginManifests } from "../lib/pluginManifests";
import { parsePluginManifest, type PluginManifest } from "@omnipanel/plugin-sdk";

export const PLUGIN_ID_EVERYTHING = "omni.addon.everything";
export const PLUGIN_ID_WARPGATE = "omni.importer.warpgate";

interface PluginRuntimeStore {
  items: PluginListItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  reload: () => Promise<void>;
}

async function loadItems(): Promise<PluginListItem[]> {
  return unwrapCommand(commands.pluginList());
}

export const usePluginRuntimeStore = create<PluginRuntimeStore>((set, get) => ({
  items: [],
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    await get().reload();
  },
  reload: async () => {
    try {
      const items = await loadItems();
      // 磁盘安装清单合并（失败容忍：保留上次结果，仅内置照常工作）
      try {
        const dtos = await unwrapCommand(commands.pluginManifests());
        const installed: PluginManifest[] = [];
        for (const dto of dtos) {
          if (dto.source !== "installed") continue;
          try {
            installed.push(parsePluginManifest(JSON.parse(dto.manifestJson)));
          } catch (err) {
            console.warn(`[plugin-runtime] 安装清单解析失败 ${dto.id}`, err);
          }
        }
        setInstalledPluginManifests(installed);
      } catch {
        /* 保持既有安装清单 */
      }
      set({ items, hydrated: true });
      await syncPluginLifecycles(items);
    } catch {
      set({ hydrated: true });
    }
  },
}));

export function isPluginActivated(id: string): boolean {
  const item = usePluginRuntimeStore.getState().items.find((entry) => entry.id === id);
  return Boolean(item?.enabled && item?.activated);
}

let pluginChangedUnlisten: (() => void) | null = null;
let pluginChangedSubscribeInFlight: Promise<void> | null = null;

/** 主窗与 module 子窗共用：只订阅一次 `plugin://changed`，触发 reload。 */
export async function subscribePluginRuntimeChanged(): Promise<void> {
  if (pluginChangedUnlisten) return;
  if (pluginChangedSubscribeInFlight) {
    await pluginChangedSubscribeInFlight;
    return;
  }
  pluginChangedSubscribeInFlight = (async () => {
    try {
      pluginChangedUnlisten = await listen(PLUGIN_CHANGED, () => {
        void usePluginRuntimeStore.getState().reload();
      });
    } catch {
      pluginChangedUnlisten = null;
    } finally {
      pluginChangedSubscribeInFlight = null;
    }
  })();
  await pluginChangedSubscribeInFlight;
}

export async function initPluginRuntimeStore(): Promise<void> {
  ensurePluginContributionsLoaded();
  await usePluginRuntimeStore.getState().hydrate();
  await subscribePluginRuntimeChanged();
}

/** 仅测试：重置模块级订阅，避免用例互相污染。 */
export function resetPluginRuntimeSubscriptionForTests(): void {
  pluginChangedUnlisten?.();
  pluginChangedUnlisten = null;
  pluginChangedSubscribeInFlight = null;
}
