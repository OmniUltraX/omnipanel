import { create } from "zustand";
import { loadSchemaCache, saveSchemaCache } from "../modules/database/api";
import type { SchemaCacheSnapshot } from "../modules/database/schemaCache";
import { emptySchemaCacheSnapshot } from "../modules/database/schemaCache";

interface DbSchemaCacheState {
  snapshot: SchemaCacheSnapshot;
  hydrated: boolean;
  refreshingConnectionIds: Record<string, true>;
  hydrate: () => Promise<void>;
  replaceSnapshot: (snapshot: SchemaCacheSnapshot) => Promise<void>;
  patchConnection: (connId: string, entry: SchemaCacheSnapshot["connections"][string]) => Promise<void>;
  setConnectionRefreshing: (connId: string, refreshing: boolean) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(snapshot: SchemaCacheSnapshot) {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveSchemaCache(snapshot).catch(() => {});
  }, 400);
}

export const useDbSchemaCacheStore = create<DbSchemaCacheState>((set, get) => ({
  snapshot: emptySchemaCacheSnapshot(),
  hydrated: false,
  refreshingConnectionIds: {},

  hydrate: async () => {
    if (get().hydrated) {
      return;
    }
    try {
      const snapshot = await loadSchemaCache();
      set({ snapshot, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  replaceSnapshot: async (snapshot) => {
    set({ snapshot, hydrated: true });
    schedulePersist(snapshot);
  },

  patchConnection: async (connId, entry) => {
    const next: SchemaCacheSnapshot = {
      connections: {
        ...get().snapshot.connections,
        [connId]: entry,
      },
    };
    set({ snapshot: next, hydrated: true });
    schedulePersist(next);
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
}));
