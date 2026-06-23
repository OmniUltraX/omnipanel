import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { DbColumnMeta } from "../modules/database/api";
import {
  type SqlTabState,
  type TablePreviewState,
} from "../modules/database/dbWorkspaceState";

type TabDirtyRows = Record<string, Record<string, Record<string, unknown>>>;

type RecordUpdater<T> = T | ((prev: T) => T);

function applyUpdater<T>(prev: T, updater: RecordUpdater<T>): T {
  return typeof updater === "function" ? (updater as (value: T) => T)(prev) : updater;
}

export interface DbTabWorkspaceSlice {
  sqlTabState: SqlTabState | undefined;
  tablePreview: TablePreviewState | undefined;
  tableColumnMeta: DbColumnMeta[] | undefined;
  tabMode: "data" | "sql";
  tabDirtyRows: Record<string, Record<string, unknown>>;
  isCommitting: boolean;
}

interface DbWorkspaceTabState {
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableColumnMeta: Record<string, DbColumnMeta[]>;
  tabModes: Record<string, "data" | "sql">;
  tabDirtyRows: TabDirtyRows;
  committingTabs: Set<string>;

  resetTabWorkspace: () => void;
  removeTabWorkspaceData: (tabId: string) => void;
  setSqlTabStates: (updater: RecordUpdater<Record<string, SqlTabState>>) => void;
  setTablePreviews: (updater: RecordUpdater<Record<string, TablePreviewState>>) => void;
  setTableColumnMeta: (updater: RecordUpdater<Record<string, DbColumnMeta[]>>) => void;
  setTabModes: (updater: RecordUpdater<Record<string, "data" | "sql">>) => void;
  setTabMode: (tabId: string, mode: "data" | "sql") => void;
  setTabDirtyRows: (updater: RecordUpdater<TabDirtyRows>) => void;
  setCommittingTabs: (updater: RecordUpdater<Set<string>>) => void;
}

function emptyCommittingTabs(): Set<string> {
  return new Set();
}

/** 无脏行时的稳定空对象，避免 selector 每次返回新 {} 触发无限重渲染。 */
export const EMPTY_TAB_DIRTY_ROWS: Record<string, Record<string, unknown>> = {};

export const useDbWorkspaceTabStore = create<DbWorkspaceTabState>((set) => ({
  sqlTabStates: {},
  tablePreviews: {},
  tableColumnMeta: {},
  tabModes: {},
  tabDirtyRows: {},
  committingTabs: emptyCommittingTabs(),

  resetTabWorkspace: () =>
    set({
      sqlTabStates: {},
      tablePreviews: {},
      tableColumnMeta: {},
      tabModes: {},
      tabDirtyRows: {},
      committingTabs: emptyCommittingTabs(),
    }),

  removeTabWorkspaceData: (tabId) =>
    set((state) => {
      const nextSql = { ...state.sqlTabStates };
      delete nextSql[tabId];
      const nextPreviews = { ...state.tablePreviews };
      delete nextPreviews[tabId];
      const nextColMeta = { ...state.tableColumnMeta };
      delete nextColMeta[tabId];
      const nextModes = { ...state.tabModes };
      delete nextModes[tabId];
      const nextDirty = { ...state.tabDirtyRows };
      delete nextDirty[tabId];
      const nextCommitting = new Set(state.committingTabs);
      nextCommitting.delete(tabId);
      return {
        sqlTabStates: nextSql,
        tablePreviews: nextPreviews,
        tableColumnMeta: nextColMeta,
        tabModes: nextModes,
        tabDirtyRows: nextDirty,
        committingTabs: nextCommitting,
      };
    }),

  setSqlTabStates: (updater) =>
    set((state) => ({ sqlTabStates: applyUpdater(state.sqlTabStates, updater) })),

  setTablePreviews: (updater) =>
    set((state) => ({ tablePreviews: applyUpdater(state.tablePreviews, updater) })),

  setTableColumnMeta: (updater) =>
    set((state) => ({ tableColumnMeta: applyUpdater(state.tableColumnMeta, updater) })),

  setTabModes: (updater) =>
    set((state) => ({ tabModes: applyUpdater(state.tabModes, updater) })),

  setTabMode: (tabId, mode) =>
    set((state) => ({
      tabModes: { ...state.tabModes, [tabId]: mode },
    })),

  setTabDirtyRows: (updater) =>
    set((state) => ({ tabDirtyRows: applyUpdater(state.tabDirtyRows, updater) })),

  setCommittingTabs: (updater) =>
    set((state) => ({ committingTabs: applyUpdater(state.committingTabs, updater) })),
}));

/** 按 tabId 订阅工作区切片，避免其它 Tab 数据变更触发 reconcile。 */
export function useDbTabWorkspaceSlice(tabId: string): DbTabWorkspaceSlice {
  return useDbWorkspaceTabStore(
    useShallow((state) => ({
      sqlTabState: state.sqlTabStates[tabId],
      tablePreview: state.tablePreviews[tabId],
      tableColumnMeta: state.tableColumnMeta[tabId],
      tabMode: state.tabModes[tabId] ?? "sql",
      tabDirtyRows: state.tabDirtyRows[tabId] ?? EMPTY_TAB_DIRTY_ROWS,
      isCommitting: state.committingTabs.has(tabId),
    })),
  );
}

export function isTablePreviewTabId(tabId: string): boolean {
  const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
  return Boolean(preview?.tableName);
}

export function selectDbTabWorkspaceMirrorSlice(state: DbWorkspaceTabState) {
  return {
    sqlTabStates: state.sqlTabStates,
    tablePreviews: state.tablePreviews,
    tableColumnMeta: state.tableColumnMeta,
    tabModes: state.tabModes,
    tabDirtyRows: state.tabDirtyRows,
    committingTabs: state.committingTabs,
  };
}
