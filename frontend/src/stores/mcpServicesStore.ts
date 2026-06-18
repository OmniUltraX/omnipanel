import { create } from "zustand";

import { commands, type McpServiceView, type UpsertMcpServiceInput } from "../ipc/bindings";

interface McpServicesState {
  services: McpServiceView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  upsertService: (input: UpsertMcpServiceInput) => Promise<McpServiceView | null>;
  removeService: (id: string) => Promise<boolean>;
  setEnabled: (id: string, enabled: boolean) => Promise<McpServiceView | null>;
  setServiceRunning: (id: string, running: boolean) => Promise<McpServiceView | null>;
}

export const useMcpServicesStore = create<McpServicesState>()((set, get) => ({
  services: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const result = await commands.mcpListServices();
      if (result.status === "ok") {
        set({ services: result.data, loading: false });
      } else {
        set({ loading: false, error: result.error ?? "加载 MCP 服务失败" });
      }
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "加载 MCP 服务失败",
      });
    }
  },

  upsertService: async (input) => {
    set({ error: null });
    try {
      const result = await commands.mcpUpsertService(input);
      if (result.status === "ok") {
        await get().refresh();
        return result.data;
      }
      set({ error: result.error ?? "保存 MCP 服务失败" });
      return null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "保存 MCP 服务失败" });
      return null;
    }
  },

  removeService: async (id) => {
    set({ error: null });
    try {
      const result = await commands.mcpDeleteService(id);
      if (result.status === "ok") {
        await get().refresh();
        return true;
      }
      set({ error: result.error ?? "删除 MCP 服务失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "删除 MCP 服务失败" });
      return false;
    }
  },

  setEnabled: async (id, enabled) => {
    set({ error: null });
    try {
      const result = await commands.mcpSetServiceEnabled(id, enabled);
      if (result.status === "ok") {
        await get().refresh();
        return result.data;
      }
      set({ error: result.error ?? "更新 MCP 服务状态失败" });
      return null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "更新 MCP 服务状态失败" });
      return null;
    }
  },

  setServiceRunning: async (id, running) => {
    set({ error: null });
    try {
      const result = await commands.mcpSetServiceRunning(id, running);
      if (result.status === "ok") {
        await get().refresh();
        return result.data;
      }
      set({ error: result.error ?? "更新 MCP 服务运行状态失败" });
      return null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "更新 MCP 服务运行状态失败" });
      return null;
    }
  },
}));

export type { McpServiceView, UpsertMcpServiceInput };

export function formatMcpTransportSummary(service: McpServiceView): string {
  if (service.endpoint) {
    return service.endpoint;
  }
  if (service.transport.kind === "stdio") {
    const cfg = service.transport.config;
    const args = cfg.args?.length ? ` ${cfg.args.join(" ")}` : "";
    return `${cfg.command}${args}`;
  }
  return service.transport.config.url;
}

export function mcpStatusLabelKey(
  status: McpServiceView["status"],
): "running" | "stopped" | "starting" | "error" {
  return status;
}
