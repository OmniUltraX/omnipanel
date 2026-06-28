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
  /** DB 中是否标记为启用 */
  isEnabled: (toolName: string) => boolean;
  /** 是否可注册/可调用：DB 启用且所属模块为打开 */
  isAvailable: (toolName: string) => boolean;
  setEnabled: (toolName: string, enabled: boolean) => Promise<void>;
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

  isEnabled: (toolName) => {
    const tool = get().tools.find((t) => t.tool_name === toolName);
    return tool?.enabled ?? false;
  },

  isAvailable: (toolName) => {
    const tool = get().tools.find((t) => t.tool_name === toolName);
    if (!tool?.enabled) return false;
    return isModuleOpen(tool.module_key as ModuleKey);
  },

  setEnabled: async (toolName, enabled) => {
    const res = await commands.mcpToolSetEnabled(toolName, enabled);
    if (res.status !== "ok") return;
    const updated = res.data;
    set((state) => ({
      tools: state.tools.some((t) => t.tool_name === toolName)
        ? state.tools.map((t) => (t.tool_name === toolName ? updated : t))
        : [...state.tools, updated],
    }));
  },
}));

/** 工具是否可注册/可调用 */
export function isMcpToolAvailable(toolName: string): boolean {
  return useMcpToolStore.getState().isAvailable(toolName);
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
