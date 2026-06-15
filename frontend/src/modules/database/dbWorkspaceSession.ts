import type { SqlTabState, TablePreviewState } from "./dbWorkspaceState";
import type { SqlWorkspaceTab } from "./workspaceTabs";

export interface DbSqlTabStateSnapshot {
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
}

/** 数据库模块右侧 dock 工作区会话（不含查询结果、脏数据等运行时状态）。 */
export interface DbWorkspaceSessionSnapshot {
  tabs: SqlWorkspaceTab[];
  activeTabId: string;
  sqlTabStates: Record<string, DbSqlTabStateSnapshot>;
  tablePreviewMeta: Record<string, DbTablePreviewMetaSnapshot>;
  tabModes: Record<string, "data" | "sql">;
}

export function sanitizeWorkspaceSession(
  session: DbWorkspaceSessionSnapshot | null | undefined,
): DbWorkspaceSessionSnapshot | null {
  if (!session?.tabs?.length) {
    return null;
  }

  const tabIds = new Set(session.tabs.map((tab) => tab.id));
  let activeTabId = session.activeTabId;
  if (!tabIds.has(activeTabId)) {
    activeTabId = session.tabs[0].id;
  }

  const pick = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => tabIds.has(key)));

  return {
    tabs: session.tabs,
    activeTabId,
    sqlTabStates: pick(session.sqlTabStates ?? {}),
    tablePreviewMeta: pick(session.tablePreviewMeta ?? {}),
    tabModes: pick(session.tabModes ?? {}),
  };
}

export function buildWorkspaceSessionSnapshot(params: {
  tabs: SqlWorkspaceTab[];
  activeTabId: string;
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tabModes: Record<string, "data" | "sql">;
}): DbWorkspaceSessionSnapshot {
  const tabIds = new Set(params.tabs.map((tab) => tab.id));

  const sqlTabStates: Record<string, DbSqlTabStateSnapshot> = {};
  for (const tabId of tabIds) {
    const state = params.sqlTabStates[tabId];
    if (!state) {
      continue;
    }
    sqlTabStates[tabId] = {
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
    };
  }

  const tabModes: Record<string, "data" | "sql"> = {};
  for (const tabId of tabIds) {
    const mode = params.tabModes[tabId];
    if (mode) {
      tabModes[tabId] = mode;
    }
  }

  return {
    tabs: params.tabs,
    activeTabId: params.activeTabId,
    sqlTabStates,
    tablePreviewMeta,
    tabModes,
  };
}
