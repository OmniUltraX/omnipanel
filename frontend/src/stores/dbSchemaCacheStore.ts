import { create } from "zustand";
import { loadSchemaCache, patchSchemaCache, saveSchemaCache } from "../modules/database/api";
import type { SchemaCacheSnapshot } from "../modules/database/schema/schemaCache";
import { emptySchemaCacheSnapshot } from "../modules/database/schema/schemaCache";

interface DbSchemaCacheState {
  snapshot: SchemaCacheSnapshot;
  hydrated: boolean;
  /** 递增以通知订阅方缓存有变，避免整对象引用订阅拖垮 DatabasePanel */
  revision: number;
  /** 工具栏 / 全量刷新时标记整连接 */
  refreshingConnectionIds: Record<string, true>;
  /** 右键单节点刷新时仅标记该节点 */
  refreshingNodeIds: Record<string, true>;
  hydrate: () => Promise<void>;
  replaceSnapshot: (snapshot: SchemaCacheSnapshot, options?: { persist?: boolean }) => Promise<void>;
  patchConnection: (
    connId: string,
    entry: SchemaCacheSnapshot["connections"][string],
    options?: { persist?: boolean },
  ) => Promise<void>;
  setConnectionRefreshing: (connId: string, refreshing: boolean) => void;
  setNodeRefreshing: (nodeId: string, refreshing: boolean) => void;
  clearConnectionRefreshing: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 防抖窗口内待增量写入的连接 */
const pendingConnectionPatches = new Map<
  string,
  SchemaCacheSnapshot["connections"][string]
>();

function schedulePersistConnection(
  connId: string,
  entry: SchemaCacheSnapshot["connections"][string],
  getState: () => DbSchemaCacheState,
) {
  pendingConnectionPatches.set(connId, entry);
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!getState().hydrated) {
      pendingConnectionPatches.clear();
      return;
    }
    const patches = [...pendingConnectionPatches.entries()];
    pendingConnectionPatches.clear();
    for (const [id, patchEntry] of patches) {
      void patchSchemaCache(id, patchEntry as Parameters<typeof patchSchemaCache>[1]).catch(
        () => {},
      );
    }
  }, 400);
}

function schedulePersistFullSnapshot(getState: () => DbSchemaCacheState) {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  pendingConnectionPatches.clear();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { snapshot, hydrated } = getState();
    if (!hydrated) {
      return;
    }
    void saveSchemaCache(snapshot as Parameters<typeof saveSchemaCache>[0]).catch(() => {});
  }, 400);
}

export const useDbSchemaCacheStore = create<DbSchemaCacheState>((set, get) => ({
  snapshot: emptySchemaCacheSnapshot(),
  hydrated: false,
  revision: 0,
  refreshingConnectionIds: {},
  refreshingNodeIds: {},

  hydrate: async () => {
    if (get().hydrated) {
      return;
    }
    try {
      const snapshot = (await loadSchemaCache()) as SchemaCacheSnapshot;
      set((state) => ({ snapshot, hydrated: true, revision: state.revision + 1 }));
    } catch {
      set({ hydrated: true });
    }
  },

  replaceSnapshot: async (snapshot, options) => {
    set((state) => ({ snapshot, hydrated: true, revision: state.revision + 1 }));
    if (options?.persist === false) {
      return;
    }
    schedulePersistFullSnapshot(get);
  },

  patchConnection: async (connId, entry, options) => {
    const next: SchemaCacheSnapshot = {
      connections: {
        ...get().snapshot.connections,
        [connId]: entry,
      },
    };
    set((state) => ({ snapshot: next, hydrated: true, revision: state.revision + 1 }));
    if (options?.persist === false) {
      return;
    }
    schedulePersistConnection(connId, entry, get);
  },

  setConnectionRefreshing: (connId, refreshing) => {
    set((state) => {
      const next = { ...state.refreshingConnectionIds };
      if (refreshing) {
        next[connId] = true;
      } else {
        delete next[connId];
      }
      return { refreshingConnectionIds: next };
    });
  },

  setNodeRefreshing: (nodeId, refreshing) => {
    set((state) => {
      const next = { ...state.refreshingNodeIds };
      if (refreshing) {
        next[nodeId] = true;
      } else {
        delete next[nodeId];
      }
      return { refreshingNodeIds: next };
    });
  },

  clearConnectionRefreshing: () => {
    set({ refreshingConnectionIds: {}, refreshingNodeIds: {} });
  },
}));
