import {
  createDefaultTablePreviewState,
  DEFAULT_PAGE_SIZE,
  type SqlTabState,
  type SortState,
  type TableDesignerTabState,
  type TablePreviewState,
} from "./dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import type {
  DbWorkspaceTab,
  TablePreviewWorkspaceTab,
} from "./workspaceTabs";
import type { TableDesignerModel } from "./tableDesigner/types";

export interface DbSqlTabStateSnapshot {
  connId?: string;
  sql: string;
  database: string;
  cursorOffset: number;
}

/** 表数据 Tab 的运行时状态（分页/排序/过滤/列显示/转置），身份字段在 Tab 本身。 */
export interface DbTablePreviewStateSnapshot {
  page: number;
  pageSize: number;
  sort?: SortState | null;
  filter?: RuleGroupType | null;
  hiddenColumns?: string[];
  transposed?: boolean;
}

/** @deprecated 旧会话格式，仅用于迁移 */
export interface DbTablePreviewMetaSnapshot {
  connId: string;
  dbName: string;
  tableName: string;
  page: number;
  pageSize: number;
  sort?: SortState | null;
  filter?: RuleGroupType | null;
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
  /** 表数据 Tab 的分页/过滤状态 */
  tablePreviewStates: Record<string, DbTablePreviewStateSnapshot>;
  /** @deprecated 旧字段，读取后迁移 */
  tablePreviewMeta?: Record<string, DbTablePreviewMetaSnapshot>;
  tabModes?: Record<string, "data" | "sql">;
  tableDesignerStates: Record<string, DbTableDesignerStateSnapshot>;
}

/** 最近关闭的工作区面板（欢迎页可重新打开）。 */
export interface DbClosedPanelEntry {
  closedAt: number;
  tab: DbWorkspaceTab;
  sqlTabState?: DbSqlTabStateSnapshot;
  tablePreviewState?: DbTablePreviewStateSnapshot;
  tableDesignerState?: DbTableDesignerStateSnapshot;
}

export const DB_RECENT_CLOSED_PANEL_LIMIT = 5;

function isValidDesignerState(state: DbTableDesignerStateSnapshot | undefined): state is DbTableDesignerStateSnapshot {
  return Boolean(state?.model?.fields && state?.baseline?.fields);
}

function parseTableNameFromPreviewSql(sql: string | undefined): string | null {
  if (!sql) {
    return null;
  }
  const match = sql.match(/SELECT\s+\*\s+FROM\s+[`"']([^`"']+)[`"']/i);
  return match?.[1] ?? null;
}

function parseTableLabel(label: string): { dbName: string; tableName: string } | null {
  const dot = label.lastIndexOf(".");
  if (dot <= 0 || dot >= label.length - 1) {
    return null;
  }
  return { dbName: label.slice(0, dot), tableName: label.slice(dot + 1) };
}

function previewStateFromLegacy(
  legacy: DbTablePreviewMetaSnapshot | DbTablePreviewStateSnapshot | undefined,
): DbTablePreviewStateSnapshot | undefined {
  if (!legacy) {
    return undefined;
  }
  return {
    page: legacy.page ?? 0,
    pageSize: legacy.pageSize ?? DEFAULT_PAGE_SIZE,
    sort: legacy.sort ?? null,
    filter: legacy.filter ?? null,
    hiddenColumns:
      "hiddenColumns" in legacy && legacy.hiddenColumns
        ? [...legacy.hiddenColumns]
        : [],
    transposed: "transposed" in legacy ? (legacy.transposed ?? false) : false,
  };
}

export function tablePreviewStateToSnapshot(
  preview: TablePreviewState,
): DbTablePreviewStateSnapshot {
  return {
    page: preview.page,
    pageSize: preview.pageSize,
    sort: preview.sort ?? null,
    filter: preview.filter ?? null,
    ...(preview.hiddenColumns.length > 0
      ? { hiddenColumns: [...preview.hiddenColumns] }
      : {}),
    ...(preview.transposed ? { transposed: true } : {}),
  };
}

export function tablePreviewStateFromSnapshot(
  previewState: DbTablePreviewStateSnapshot | undefined,
  tab: Pick<TablePreviewWorkspaceTab, "connId" | "dbName" | "tableName">,
  overrides?: Partial<TablePreviewState>,
): TablePreviewState {
  return {
    ...createDefaultTablePreviewState(),
    loading: true,
    connId: tab.connId,
    dbName: tab.dbName,
    tableName: tab.tableName,
    page: previewState?.page ?? 0,
    pageSize: previewState?.pageSize ?? DEFAULT_PAGE_SIZE,
    sort: previewState?.sort ?? null,
    filter: previewState?.filter ?? null,
    hiddenColumns: previewState?.hiddenColumns ? [...previewState.hiddenColumns] : [],
    transposed: previewState?.transposed ?? false,
    ...overrides,
  };
}

/** 将旧版 sql+tablePreviewMeta 会话迁移为独立的 table Tab。 */
export function migrateLegacyWorkspaceSession(
  session: DbWorkspaceSessionSnapshot,
): DbWorkspaceSessionSnapshot {
  const legacyMeta = session.tablePreviewMeta ?? {};
  const tabModes = session.tabModes ?? {};
  const tablePreviewStates = { ...(session.tablePreviewStates ?? {}) };
  const sqlTabStates = { ...session.sqlTabStates };
  const tabs: DbWorkspaceTab[] = [];

  for (const tab of session.tabs) {
    if (tab.kind === "table") {
      tabs.push(tab);
      continue;
    }
    if (tab.kind !== "sql" || tab.sqlFileId) {
      tabs.push(tab);
      continue;
    }

    const meta = legacyMeta[tab.id];
    const sqlState = sqlTabStates[tab.id];
    const tableFromSql = parseTableNameFromPreviewSql(sqlState?.sql);
    const fromLabel = parseTableLabel(tab.label);
    const isDataTab =
      tabModes[tab.id] === "data" ||
      Boolean(meta?.connId && meta?.dbName && meta?.tableName) ||
      Boolean(tableFromSql && sqlState?.connId);

    if (!isDataTab) {
      tabs.push(tab);
      continue;
    }

    const connId = meta?.connId ?? sqlState?.connId ?? "";
    const dbName = meta?.dbName ?? sqlState?.database?.trim() ?? fromLabel?.dbName ?? "";
    const tableName = meta?.tableName ?? tableFromSql ?? fromLabel?.tableName ?? "";
    if (!connId || !dbName || !tableName) {
      tabs.push(tab);
      continue;
    }

    const tableTab: TablePreviewWorkspaceTab = {
      id: tab.id,
      kind: "table",
      label: tab.label,
      connId,
      dbName,
      tableName,
      workspaceOnly: tab.workspaceOnly,
    };
    tabs.push(tableTab);
    delete sqlTabStates[tab.id];

    if (!tablePreviewStates[tab.id]) {
      tablePreviewStates[tab.id] =
        previewStateFromLegacy(meta) ?? {
          page: 0,
          pageSize: DEFAULT_PAGE_SIZE,
          sort: null,
          filter: null,
        };
    }
  }

  return {
    ...session,
    tabs,
    sqlTabStates,
    tablePreviewStates,
    tablePreviewMeta: undefined,
    tabModes: undefined,
  };
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

  const migrated = migrateLegacyWorkspaceSession({
    ...session,
    tablePreviewStates: session.tablePreviewStates ?? {},
    tableDesignerStates: session.tableDesignerStates ?? {},
  });

  const tabs = migrated.tabs.filter((tab) => {
    if (tab.kind === "sql") return true;
    if (tab.kind === "table") {
      return Boolean(tab.connId && tab.dbName && tab.tableName);
    }
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
  let activeTabId = migrated.activeTabId;
  if (!tabIds.has(activeTabId)) {
    activeTabId = tabs[0].id;
  }

  const pick = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => tabIds.has(key)));

  const tableDesignerStates: Record<string, DbTableDesignerStateSnapshot> = {};
  for (const [tabId, state] of Object.entries(migrated.tableDesignerStates ?? {})) {
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
    sqlTabStates: pick(migrated.sqlTabStates ?? {}),
    tablePreviewStates: pick(migrated.tablePreviewStates ?? {}),
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
    if (!state || tab?.kind !== "sql") {
      continue;
    }
    if (tab.sqlFileId) {
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

  const tablePreviewStates: Record<string, DbTablePreviewStateSnapshot> = {};
  for (const tabId of tabIds) {
    const tab = params.tabs.find((item) => item.id === tabId);
    if (tab?.kind !== "table") {
      continue;
    }
    const preview = params.tablePreviews[tabId];
    if (!preview) {
      continue;
    }
    tablePreviewStates[tabId] = tablePreviewStateToSnapshot(preview);
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
    tablePreviewStates,
    tableDesignerStates,
  };
}

export function buildClosedPanelEntry(params: {
  tab: DbWorkspaceTab;
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableDesignerStates: Record<string, TableDesignerTabState>;
}): DbClosedPanelEntry {
  const { tab } = params;
  const sqlState = params.sqlTabStates[tab.id];
  const preview = params.tablePreviews[tab.id];
  const designerState = params.tableDesignerStates[tab.id];

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

  let tablePreviewState: DbTablePreviewStateSnapshot | undefined;
  if (tab.kind === "table" && preview) {
    tablePreviewState = tablePreviewStateToSnapshot(preview);
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
    tablePreviewState,
    tableDesignerState,
  };
}
