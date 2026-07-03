import { create } from "zustand";
import { commands, type McpToolCatalogEntry, type McpToolRecord } from "../ipc/bindings";
import { getAllMcpCatalogEntries } from "../lib/ai/context/moduleMcpCatalog";
import type { ModuleKey } from "../lib/paths";
import { isModuleOpen } from "./appModuleStore";

interface McpToolStore {
  tools: McpToolRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  isInternalEnabled: (toolName: string) => boolean;
  isAvailable: (toolName: string) => boolean;
  isExternalExposed: (toolName: string) => boolean;
  setInternalEnabled: (toolName: string, enabled: boolean) => Promise<void>;
  setExternalExposed: (toolName: string, exposed: boolean) => Promise<void>;
}

export const useMcpToolStore = create<McpToolStore>((set, get) => ({
  tools: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    await get().refresh();
    set({ hydrated: true });
  },

  refresh: async () => {
    try {
      await syncMcpToolCatalog();
      const res = await commands.mcpToolList();
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
    const res = await commands.mcpToolSetInternalEnabled(toolName, enabled);
    if (res.status !== "ok") return;
    const updated = res.data;
    set((state) => ({
      tools: state.tools.map((t) => (t.tool_name === toolName ? updated : t)),
    }));
  },

  setExternalExposed: async (toolName, exposed) => {
    const res = await commands.mcpToolSetExternalExposed(toolName, exposed);
    if (res.status !== "ok") return;
    const updated = res.data;
    set((state) => ({
      tools: state.tools.map((t) => (t.tool_name === toolName ? updated : t)),
    }));
  },
}));

export function isMcpToolAvailable(toolName: string): boolean {
  return useMcpToolStore.getState().isAvailable(toolName);
}

export function isMcpToolExternalExposed(toolName: string): boolean {
  return useMcpToolStore.getState().isExternalExposed(toolName);
}

/** @deprecated 使用 isMcpToolAvailable */
export function isMcpToolEnabled(toolName: string): boolean {
  return isMcpToolAvailable(toolName);
}

export async function syncMcpToolCatalog(): Promise<void> {
  const entries: McpToolCatalogEntry[] = getAllMcpCatalogEntries();
  await commands.mcpToolSyncCatalog(entries);
}

export async function initMcpToolStore(): Promise<void> {
  await useMcpToolStore.getState().hydrate();
}

export async function refreshMcpToolStore(): Promise<void> {
  await useMcpToolStore.getState().refresh();
}
