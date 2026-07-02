import { create } from "zustand";
import { loadSchemaTreeExpanded, saveSchemaTreeExpanded } from "../modules/database/api";
import type { SchemaTreeExpandedSnapshot } from "../modules/database/schema/schemaTreeExpanded";

interface DbSchemaTreeExpandedState {
  expandedNodeIds: Set<string>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  updateExpanded: (updater: (prev: Set<string>) => Set<string>) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(getState: () => DbSchemaTreeExpandedState) {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { expandedNodeIds, hydrated } = getState();
    if (!hydrated) {
      return;
    }
    const snapshot: SchemaTreeExpandedSnapshot = {
      expandedNodeIds: [...expandedNodeIds],
    };
    void saveSchemaTreeExpanded(snapshot).catch(() => {});
  }, 400);
}

export const useDbSchemaTreeExpandedStore = create<DbSchemaTreeExpandedState>((set, get) => ({
  expandedNodeIds: new Set(),
  hydrated: false,

  hydrate: async () => {
    try {
      const snapshot = await loadSchemaTreeExpanded();
      set({
        expandedNodeIds: new Set(snapshot.expandedNodeIds ?? []),
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  updateExpanded: (updater) => {
    set((state) => ({ expandedNodeIds: updater(state.expandedNodeIds) }));
    schedulePersist(get);
  },
}));
