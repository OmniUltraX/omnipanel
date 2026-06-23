import type { SqlTabState, SortState, TableDesignerTabState, TablePreviewState } from "./dbWorkspaceState";
import type { DbWorkspaceTab } from "./workspaceTabs";
import type { TableDesignerModel } from "./tableDesigner/types";

export interface DbSqlTabStateSnapshot {
  connId?: string;
  sql: string;
  database: string;
  cursorOffset: number;
}

export interface DbTablePreviewMetaSnapshot {
  connId: string;
  dbName: string;
  tableName: string;
  page: number;
  pageSize: number;
  sort?: SortState | null;
}

export interface DbTableDesignerStateSnapshot {
  model: TableDesignerModel;
  baseline: TableDesignerModel;
}

/** 数据库模块右侧 dock 工作区会话（不含查询结果、脏数据等运行时状态）。 */
export interface DbWorkspaceSessionSnapshot {
  tabs: DbWorkspaceTab[];
  activeTabId: string;
  sqlTabStates: Record<string, DbSqlTabStateSnapshot>;
  tablePreviewMeta: Record<string, DbTablePreviewMetaSnapshot>;
  tabModes: Record<string, "data" | "sql">;
  tableDesignerStates: Record<string, DbTableDesignerStateSnapshot>;
}

/** 最近关闭的工作区面板（欢迎页可重新打开）。 */
export interface DbClosedPanelEntry {
  closedAt: number;
  tab: DbWorkspaceTab;
  sqlTabState?: DbSqlTabStateSnapshot;
  tablePreviewMeta?: DbTablePreviewMetaSnapshot;
  tableDesignerState?: DbTableDesignerStateSnapshot;
  tabMode?: "data" | "sql";
}

export const DB_RECENT_CLOSED_PANEL_LIMIT = 5;

function isValidDesignerState(state: DbTableDesignerStateSnapshot | undefined): state is DbTableDesignerStateSnapshot {
  return Boolean(state?.model?.fields && state?.baseline?.fields);
}

export function restoreTableDesignerStateFromSnapshot(
  snap: DbTableDesignerStateSnapshot,
): TableDesignerTabState {
  return {
    model: structuredClone(snap.model),
    baseline: structuredClone(snap.baseline),
  };
}

export function sanitizeWorkspaceSession(
  session: DbWorkspaceSessionSnapshot | null | undefined,
): DbWorkspaceSessionSnapshot | null {
  if (!session?.tabs?.length) {
    return null;
  }

  const tabs = session.tabs.filter((tab) => {
    if (tab.kind === "sql") return true;
    if (tab.kind === "database") {
      return Boolean(tab.connId && tab.dbName);
    }
    if (tab.kind === "designer") {
      return Boolean(tab.connId && tab.dbName && tab.tableName);
    }
    if (tab.kind === "connection") {
      return Boolean(tab.connId);
    }
    if (tab.kind === "redis-query") {
      return Boolean(tab.connId);
    }
    return false;
  });
  if (tabs.length === 0) {
    return null;
  }

  const tabIds = new Set(tabs.map((tab) => tab.id));
  let activeTabId = session.activeTabId;
  if (!tabIds.has(activeTabId)) {
    activeTabId = tabs[0].id;
  }

  const pick = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => tabIds.has(key)));

  const tableDesignerStates: Record<string, DbTableDesignerStateSnapshot> = {};
  for (const [tabId, state] of Object.entries(session.tableDesignerStates ?? {})) {
    if (!tabIds.has(tabId) || !isValidDesignerState(state)) {
      continue;
    }
    tableDesignerStates[tabId] = {
      model: state.model,
      baseline: state.baseline,
    };
  }

  return {
    tabs,
    activeTabId,
    sqlTabStates: pick(session.sqlTabStates ?? {}),
    tablePreviewMeta: pick(session.tablePreviewMeta ?? {}),
    tabModes: pick(session.tabModes ?? {}),
    tableDesignerStates,
  };
}

export function buildWorkspaceSessionSnapshot(params: {
  tabs: DbWorkspaceTab[];
  activeTabId: string;
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tabModes: Record<string, "data" | "sql">;
  tableDesignerStates: Record<string, TableDesignerTabState>;
}): DbWorkspaceSessionSnapshot {
  const tabIds = new Set(params.tabs.map((tab) => tab.id));

  const sqlTabStates: Record<string, DbSqlTabStateSnapshot> = {};
  for (const tabId of tabIds) {
    const tab = params.tabs.find((item) => item.id === tabId);
    const state = params.sqlTabStates[tabId];
    if (!state) {
      continue;
    }
    if (tab?.kind === "sql" && tab.sqlFileId) {
      sqlTabStates[tabId] = {
        cursorOffset: state.cursorOffset,
        sql: "",
        database: "",
        connId: state.connId,
      };
      continue;
    }
    sqlTabStates[tabId] = {
      connId: state.connId,
      sql: state.sql,
      database: state.database,
      cursorOffset: state.cursorOffset,
    };
  }

  const tablePreviewMeta: Record<string, DbTablePreviewMetaSnapshot> = {};
  for (const tabId of tabIds) {
    const preview = params.tablePreviews[tabId];
    if (!preview?.connId || !preview.dbName || !preview.tableName) {
      continue;
    }
    tablePreviewMeta[tabId] = {
      connId: preview.connId,
      dbName: preview.dbName,
      tableName: preview.tableName,
      page: preview.page,
      pageSize: preview.pageSize,
      sort: preview.sort ?? null,
    };
  }

  const tabModes: Record<string, "data" | "sql"> = {};
  for (const tabId of tabIds) {
    const mode = params.tabModes[tabId];
    if (mode) {
      tabModes[tabId] = mode;
    }
  }

  const tableDesignerStates: Record<string, DbTableDesignerStateSnapshot> = {};
  for (const tabId of tabIds) {
    const tab = params.tabs.find((item) => item.id === tabId);
    if (tab?.kind !== "designer") {
      continue;
    }
    const state = params.tableDesignerStates[tabId];
    if (!state?.model || !state?.baseline) {
      continue;
    }
    tableDesignerStates[tabId] = {
      model: state.model,
      baseline: state.baseline,
    };
  }

  return {
    tabs: params.tabs,
    activeTabId: tabIds.has(params.activeTabId) ? params.activeTabId : params.tabs[0]?.id ?? "",
    sqlTabStates,
    tablePreviewMeta,
    tabModes,
    tableDesignerStates,
  };
}

export function buildClosedPanelEntry(params: {
  tab: DbWorkspaceTab;
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableDesignerStates: Record<string, TableDesignerTabState>;
  tabModes: Record<string, "data" | "sql">;
}): DbClosedPanelEntry {
  const { tab } = params;
  const sqlState = params.sqlTabStates[tab.id];
  const preview = params.tablePreviews[tab.id];
  const designerState = params.tableDesignerStates[tab.id];
  const mode = params.tabModes[tab.id];

  let sqlTabState: DbSqlTabStateSnapshot | undefined;
  if (tab.kind === "sql" && sqlState) {
    if (tab.sqlFileId) {
      sqlTabState = {
        cursorOffset: sqlState.cursorOffset,
        sql: "",
        database: "",
        connId: sqlState.connId,
      };
    } else {
      sqlTabState = {
        connId: sqlState.connId,
        sql: sqlState.sql,
        database: sqlState.database,
        cursorOffset: sqlState.cursorOffset,
      };
    }
  }

  let tablePreviewMeta: DbTablePreviewMetaSnapshot | undefined;
  if (preview?.connId && preview.dbName && preview.tableName) {
    tablePreviewMeta = {
      connId: preview.connId,
      dbName: preview.dbName,
      tableName: preview.tableName,
      page: preview.page,
      pageSize: preview.pageSize,
      sort: preview.sort ?? null,
    };
  }

  let tableDesignerState: DbTableDesignerStateSnapshot | undefined;
  if (tab.kind === "designer" && designerState?.model && designerState?.baseline) {
    tableDesignerState = {
      model: designerState.model,
      baseline: designerState.baseline,
    };
  }

  return {
    closedAt: Date.now(),
    tab: { ...tab },
    sqlTabState,
    tablePreviewMeta,
    tableDesignerState,
    tabMode: mode,
  };
}
