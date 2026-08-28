import { create } from "zustand";

import type { DbConnectionConfig } from "../modules/database/api";

/** 数据库连接列表刷新后通知侧栏等本地 state 同步（非 Tauri 事件）。 */
export const DB_CONNECTIONS_CHANGED_EVENT = "omnipanel:db-connections-changed";

function isEnabled(connection: Pick<DbConnectionConfig, "enabled">): boolean {
  return connection.enabled !== false;
}

/**
 * 数据库连接列表的前端缓存。
 *
 * 真实数据在独立存储 `db_list_connections`（非统一 `conn_list`）。
 * AI Composer `@` 菜单、上下文注入等需读这里，避免与侧栏本地数据不一致。
 */
interface DbConnectionListState {
  connections: DbConnectionConfig[];
  loaded: boolean;
  loading: boolean;
  refresh: () => Promise<DbConnectionConfig[]>;
  /** 启动预热写入，不触发 loading 闪烁 */
  hydrate: (list: DbConnectionConfig[]) => void;
}

export const useDbConnectionListStore = create<DbConnectionListState>((set, get) => ({
  connections: [],
  loaded: false,
  loading: false,

  hydrate: (list) => {
    set({
      connections: list.filter(isEnabled),
      loaded: true,
      loading: false,
    });
  },

  refresh: async () => {
    set({ loading: true });
    try {
      // 动态导入避免与 database/api 形成顶层循环依赖
      const { listConnections } = await import("../modules/database/api");
      const list = await listConnections();
      const enabled = list.filter(isEnabled);
      set({ connections: enabled, loaded: true, loading: false });
      window.dispatchEvent(new Event(DB_CONNECTIONS_CHANGED_EVENT));
      return enabled;
    } catch {
      set({ loaded: true, loading: false });
      return get().connections;
    }
  },
}));

/** 非 hook 读取，供 buildComposerExplicitContextAppend 等路径使用。 */
export function getDbConnectionList(): DbConnectionConfig[] {
  return useDbConnectionListStore.getState().connections;
}
