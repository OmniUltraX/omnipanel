import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { DbColumnMeta } from "../modules/database/api";
import {
  type SqlTabState,
  type TablePreviewState,
} from "../modules/database/workspace/dbWorkspaceState";
import type { DbWorkspaceTab, TablePreviewWorkspaceTab } from "../modules/database/workspace/workspaceTabs";

type TabDirtyRows = Record<string, Record<string, Record<string, unknown>>>;
type DirtyRows = Record<string, Record<string, unknown>>;
type DirtyHistoryBucket = { past: DirtyRows[]; future: DirtyRows[] };

type RecordUpdater<T> = T | ((prev: T) => T);

const MAX_DIRTY_HISTORY = 40;

function applyUpdater<T>(prev: T, updater: RecordUpdater<T>): T {
  return typeof updater === "function" ? (updater as (value: T) => T)(prev) : updater;
}

function cloneDirtyRows(rows: DirtyRows | undefined): DirtyRows {
  if (!rows) return {};
  const keys = Object.keys(rows);
  if (keys.length === 0) return {};
  const next: DirtyRows = {};
  for (const rowKey of keys) {
    const changes = rows[rowKey];
    if (!changes) continue;
    next[rowKey] = { ...changes };
  }
  return next;
}

function dirtyRowsEqual(a: DirtyRows | undefined, b: DirtyRows | undefined): boolean {
  const left = a ?? EMPTY_TAB_DIRTY_ROWS;
  const right = b ?? EMPTY_TAB_DIRTY_ROWS;
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const rowKey of leftKeys) {
    const leftChanges = left[rowKey];
    const rightChanges = right[rowKey];
    if (leftChanges === rightChanges) continue;
    if (!leftChanges || !rightChanges) return false;
    const leftCols = Object.keys(leftChanges);
    const rightCols = Object.keys(rightChanges);
    if (leftCols.length !== rightCols.length) return false;
    for (const col of leftCols) {
      if (!Object.prototype.hasOwnProperty.call(rightChanges, col)) return false;
      if (!Object.is(leftChanges[col], rightChanges[col])) return false;
    }
  }
  return true;
}

export interface DbTabWorkspaceSlice {
  sqlTabState: SqlTabState | undefined;
  tablePreview: TablePreviewState | undefined;
  tableColumnMeta: DbColumnMeta[] | undefined;
  tabMode: "data" | "sql";
  tabDirtyRows: Record<string, Record<string, unknown>>;
  isCommitting: boolean;
  canUndoDirty: boolean;
  canRedoDirty: boolean;
}

interface DbWorkspaceTabState {
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableColumnMeta: Record<string, DbColumnMeta[]>;
  tabModes: Record<string, "data" | "sql">;
  tabDirtyRows: TabDirtyRows;
  tabDirtyHistory: Record<string, DirtyHistoryBucket>;
  committingTabs: Set<string>;

  resetTabWorkspace: () => void;
  removeTabWorkspaceData: (tabId: string) => void;
  setSqlTabStates: (updater: RecordUpdater<Record<string, SqlTabState>>) => void;
  setTablePreviews: (updater: RecordUpdater<Record<string, TablePreviewState>>) => void;
  setTableColumnMeta: (updater: RecordUpdater<Record<string, DbColumnMeta[]>>) => void;
  setTabModes: (updater: RecordUpdater<Record<string, "data" | "sql">>) => void;
  setTabMode: (tabId: string, mode: "data" | "sql") => void;
  setTabDirtyRows: (updater: RecordUpdater<TabDirtyRows>) => void;
  undoTabDirty: (tabId: string) => boolean;
  redoTabDirty: (tabId: string) => boolean;
  clearTabDirtyHistory: (tabId: string) => void;
  setCommittingTabs: (updater: RecordUpdater<Set<string>>) => void;
}

function emptyCommittingTabs(): Set<string> {
  return new Set();
}

/** 无脏行时的稳定空对象，避免 selector 每次返回新 {} 触发无限重渲染。 */
export const EMPTY_TAB_DIRTY_ROWS: Record<string, Record<string, unknown>> = {};

export const useDbWorkspaceTabStore = create<DbWorkspaceTabState>((set, get) => ({
  sqlTabStates: {},
  tablePreviews: {},
  tableColumnMeta: {},
  tabModes: {},
  tabDirtyRows: {},
  tabDirtyHistory: {},
  committingTabs: emptyCommittingTabs(),

  resetTabWorkspace: () =>
    set({
      sqlTabStates: {},
      tablePreviews: {},
      tableColumnMeta: {},
      tabModes: {},
      tabDirtyRows: {},
      tabDirtyHistory: {},
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
      const nextHistory = { ...state.tabDirtyHistory };
      delete nextHistory[tabId];
      const nextCommitting = new Set(state.committingTabs);
      nextCommitting.delete(tabId);
      return {
        sqlTabStates: nextSql,
        tablePreviews: nextPreviews,
        tableColumnMeta: nextColMeta,
        tabModes: nextModes,
        tabDirtyRows: nextDirty,
        tabDirtyHistory: nextHistory,
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
    set((state) => {
      const nextAll = applyUpdater(state.tabDirtyRows, updater);
      let history = state.tabDirtyHistory;
      let historyChanged = false;
      const tabIds = new Set([...Object.keys(state.tabDirtyRows), ...Object.keys(nextAll)]);
      for (const tabId of tabIds) {
        if (dirtyRowsEqual(state.tabDirtyRows[tabId], nextAll[tabId])) continue;
        historyChanged = true;
        const entry = history[tabId] ?? { past: [], future: [] };
        history = {
          ...history,
          [tabId]: {
            past: [...entry.past, cloneDirtyRows(state.tabDirtyRows[tabId])].slice(-MAX_DIRTY_HISTORY),
            future: [],
          },
        };
      }
      return historyChanged
        ? { tabDirtyRows: nextAll, tabDirtyHistory: history }
        : { tabDirtyRows: nextAll };
    }),

  undoTabDirty: (tabId) => {
    const state = get();
    const entry = state.tabDirtyHistory[tabId];
    if (!entry?.past.length) return false;
    const past = [...entry.past];
    const snapshot = past.pop()!;
    const current = cloneDirtyRows(state.tabDirtyRows[tabId]);
    const nextDirty = { ...state.tabDirtyRows };
    if (Object.keys(snapshot).length === 0) {
      delete nextDirty[tabId];
    } else {
      nextDirty[tabId] = snapshot;
    }
    set({
      tabDirtyRows: nextDirty,
      tabDirtyHistory: {
        ...state.tabDirtyHistory,
        [tabId]: { past, future: [current, ...entry.future] },
      },
    });
    return true;
  },

  redoTabDirty: (tabId) => {
    const state = get();
    const entry = state.tabDirtyHistory[tabId];
    if (!entry?.future.length) return false;
    const future = [...entry.future];
    const snapshot = future.shift()!;
    const current = cloneDirtyRows(state.tabDirtyRows[tabId]);
    const nextDirty = { ...state.tabDirtyRows };
    if (Object.keys(snapshot).length === 0) {
      delete nextDirty[tabId];
    } else {
      nextDirty[tabId] = snapshot;
    }
    set({
      tabDirtyRows: nextDirty,
      tabDirtyHistory: {
        ...state.tabDirtyHistory,
        [tabId]: {
          past: [...entry.past, current].slice(-MAX_DIRTY_HISTORY),
          future,
        },
      },
    });
    return true;
  },

  clearTabDirtyHistory: (tabId) =>
    set((state) => {
      if (!(tabId in state.tabDirtyHistory)) return state;
      const next = { ...state.tabDirtyHistory };
      delete next[tabId];
      return { tabDirtyHistory: next };
    }),

  setCommittingTabs: (updater) =>
    set((state) => ({ committingTabs: applyUpdater(state.committingTabs, updater) })),
}));

/** 按 tabId 订阅工作区切片，避免其它 Tab 数据变更触发 reconcile。 */
export function useDbTabWorkspaceSlice(tabId: string): DbTabWorkspaceSlice {
  return useDbWorkspaceTabStore(
    useShallow((state) => {
      const history = state.tabDirtyHistory[tabId];
      return {
        sqlTabState: state.sqlTabStates[tabId],
        tablePreview: state.tablePreviews[tabId],
        tableColumnMeta: state.tableColumnMeta[tabId],
        tabMode: state.tabModes[tabId] ?? "sql",
        tabDirtyRows: state.tabDirtyRows[tabId] ?? EMPTY_TAB_DIRTY_ROWS,
        isCommitting: state.committingTabs.has(tabId),
        canUndoDirty: (history?.past.length ?? 0) > 0,
        canRedoDirty: (history?.future.length ?? 0) > 0,
      };
    }),
  );
}

export function isTablePreviewTab(tab: DbWorkspaceTab): tab is TablePreviewWorkspaceTab {
  return tab.kind === "table";
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
