import { create } from "zustand";

/** 与终端 topbar-tab-dot 对齐的运行时连接状态 */
export type DbConnectionRuntimeStatus = "idle" | "connecting" | "online" | "offline";

interface DbConnectionRuntimeState {
  statusByConnId: Record<string, DbConnectionRuntimeStatus>;
  setStatus: (connId: string, status: DbConnectionRuntimeStatus) => void;
  setStatuses: (entries: Record<string, DbConnectionRuntimeStatus>) => void;
  markConnecting: (connIds: string[]) => void;
  markOnline: (connIds: string[]) => void;
  markOffline: (connIds: string[]) => void;
  /** 配置关闭 → offline；配置重新启用且无其它状态时回到 idle */
  syncEnabled: (connId: string, enabled: boolean) => void;
  clear: () => void;
}

export function dbConnectionStatusDotClass(status: DbConnectionRuntimeStatus): string {
  if (status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

export const useDbConnectionRuntimeStore = create<DbConnectionRuntimeState>((set, get) => ({
  statusByConnId: {},

  setStatus: (connId, status) => {
    set((state) => {
      if (state.statusByConnId[connId] === status) return state;
      return {
        statusByConnId: { ...state.statusByConnId, [connId]: status },
      };
    });
  },

  setStatuses: (entries) => {
    set((state) => ({
      statusByConnId: { ...state.statusByConnId, ...entries },
    }));
  },

  markConnecting: (connIds) => {
    if (connIds.length === 0) return;
    set((state) => {
      const next = { ...state.statusByConnId };
      let changed = false;
      for (const id of connIds) {
        if (next[id] !== "connecting") {
          next[id] = "connecting";
          changed = true;
        }
      }
      return changed ? { statusByConnId: next } : state;
    });
  },

  markOnline: (connIds) => {
    if (connIds.length === 0) return;
    set((state) => {
      const next = { ...state.statusByConnId };
      let changed = false;
      for (const id of connIds) {
        if (next[id] !== "online") {
          next[id] = "online";
          changed = true;
        }
      }
      return changed ? { statusByConnId: next } : state;
    });
  },

  markOffline: (connIds) => {
    if (connIds.length === 0) return;
    set((state) => {
      const next = { ...state.statusByConnId };
      let changed = false;
      for (const id of connIds) {
        if (next[id] !== "offline") {
          next[id] = "offline";
          changed = true;
        }
      }
      return changed ? { statusByConnId: next } : state;
    });
  },

  syncEnabled: (connId, enabled) => {
    const current = get().statusByConnId[connId];
    if (!enabled) {
      if (current !== "offline") {
        get().setStatus(connId, "offline");
      }
      return;
    }
    if (current === "offline" || current === undefined) {
      get().setStatus(connId, "idle");
    }
  },

  clear: () => set({ statusByConnId: {} }),
}));

export function resolveDbConnectionRuntimeStatus(
  connId: string,
  enabled: boolean,
  statusByConnId: Record<string, DbConnectionRuntimeStatus>,
): DbConnectionRuntimeStatus {
  if (!enabled) return "offline";
  return statusByConnId[connId] ?? "idle";
}
