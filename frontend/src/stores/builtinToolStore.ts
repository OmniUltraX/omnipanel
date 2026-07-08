import { create } from "zustand";
import { commands, type BuiltinToolCatalogEntry, type BuiltinToolRecord } from "../ipc/bindings";
import { getAllBuiltinCatalogEntries } from "../lib/ai/context/moduleBuiltinCatalog";
import type { ModuleKey } from "../lib/paths";
import { isModuleOpen } from "./appModuleStore";

interface BuiltinToolStore {
  tools: BuiltinToolRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  isInternalEnabled: (toolName: string) => boolean;
  isAvailable: (toolName: string) => boolean;
  isExternalExposed: (toolName: string) => boolean;
  setInternalEnabled: (toolName: string, enabled: boolean) => Promise<void>;
  setExternalExposed: (toolName: string, exposed: boolean) => Promise<void>;
}

export const useBuiltinToolStore = create<BuiltinToolStore>((set, get) => ({
  tools: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    await get().refresh();
    set({ hydrated: true });
  },

  refresh: async () => {
    try {
      await syncBuiltinToolCatalog();
      const res = await commands.builtinToolList();
      if (res.status === "ok") {
        set({ tools: res.data });
      }
    } catch {
      // 忽略刷新失败
    }
  },

  isInternalEnabled: (toolName) => {
    const tool = get().tools.find((t) => t.tool_name === toolName);
    return tool?.internal_enabled ?? false;
  },

  isAvailable: (toolName) => {
    const tool = get().tools.find((t) => t.tool_name === toolName);
    if (!tool?.internal_enabled) return false;
    return isModuleOpen(tool.module_key as ModuleKey);
  },

  isExternalExposed: (toolName) => {
    const tool = get().tools.find((t) => t.tool_name === toolName);
    if (!tool?.external_exposed) return false;
    return isModuleOpen(tool.module_key as ModuleKey);
  },

  setInternalEnabled: async (toolName, enabled) => {
    const res = await commands.builtinToolSetInternalEnabled(toolName, enabled);
    if (res.status !== "ok") return;
    const updated = res.data;
    set((state) => ({
      tools: state.tools.map((t) => (t.tool_name === toolName ? updated : t)),
    }));
  },

  setExternalExposed: async (toolName, exposed) => {
    const res = await commands.builtinToolSetExternalExposed(toolName, exposed);
    if (res.status !== "ok") return;
    const updated = res.data;
    set((state) => ({
      tools: state.tools.map((t) => (t.tool_name === toolName ? updated : t)),
    }));
  },
}));

export function isBuiltinToolAvailable(toolName: string): boolean {
  return useBuiltinToolStore.getState().isAvailable(toolName);
}

export function isBuiltinToolExternalExposed(toolName: string): boolean {
  return useBuiltinToolStore.getState().isExternalExposed(toolName);
}

export async function syncBuiltinToolCatalog(): Promise<void> {
  const entries: BuiltinToolCatalogEntry[] = getAllBuiltinCatalogEntries();
  await commands.builtinToolSyncCatalog(entries);
}

export async function initBuiltinToolStore(): Promise<void> {
  await useBuiltinToolStore.getState().hydrate();
}

export async function refreshBuiltinToolStore(): Promise<void> {
  await useBuiltinToolStore.getState().refresh();
}
