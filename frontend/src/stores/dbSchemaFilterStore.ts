import { create } from "zustand";
import { loadSchemaFilters, saveSchemaFilters } from "../modules/database/api";
import type { SchemaFilterState } from "../modules/database/DatabaseFilterDialog";
import { filterStatesToSnapshot, snapshotToFilterStates } from "../modules/database/schemaFilters";

interface DbSchemaFilterState {
  databaseFilters: Record<string, SchemaFilterState>;
  tableFilters: Record<string, SchemaFilterState>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDatabaseFilters: (
    updater: (prev: Record<string, SchemaFilterState>) => Record<string, SchemaFilterState>,
  ) => void;
  setTableFilters: (
    updater: (prev: Record<string, SchemaFilterState>) => Record<string, SchemaFilterState>,
  ) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(getState: () => DbSchemaFilterState) {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { databaseFilters, tableFilters, hydrated } = getState();
    if (!hydrated) {
      return;
    }
    void saveSchemaFilters(filterStatesToSnapshot(databaseFilters, tableFilters)).catch(() => {});
  }, 400);
}

export const useDbSchemaFilterStore = create<DbSchemaFilterState>((set, get) => ({
  databaseFilters: {},
  tableFilters: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const snapshot = await loadSchemaFilters();
      const loaded = snapshotToFilterStates(snapshot);
      set({
        databaseFilters: loaded.databaseFilters,
        tableFilters: loaded.tableFilters,
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  setDatabaseFilters: (updater) => {
    set((state) => ({ databaseFilters: updater(state.databaseFilters) }));
    schedulePersist(get);
  },

  setTableFilters: (updater) => {
    set((state) => ({ tableFilters: updater(state.tableFilters) }));
    schedulePersist(get);
  },
}));
