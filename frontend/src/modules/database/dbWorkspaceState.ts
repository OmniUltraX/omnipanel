import type { RuleGroupType } from "react-querybuilder";
import type { SqlEditorOpenMode } from "./SqlEditor";
import type { TablePreviewResult, DbColumnMeta } from "./api";
import type { TableDesignerModel } from "./tableDesigner/types";

export {
  type DbWorkspaceTab,
  type SqlWorkspaceTab,
} from "./workspaceTabs";
import type { DbWorkspaceTab } from "./workspaceTabs";

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
};

export type SortDirection = "asc" | "desc";

export type SortState = {
  column: string;
  direction: SortDirection;
};

export type TablePreviewState = {
  loading: boolean;
  error: string | null;
  data: TablePreviewResult | null;
  totalRows: number;
  page: number;
  pageSize: number;
  connId?: string;
  dbName?: string;
  tableName?: string;
  sort: SortState | null;
  filter: RuleGroupType | null;
};

export type TableDesignerTabState = {
  model: TableDesignerModel;
  baseline: TableDesignerModel;
};

export type SqlTabState = {
  /** 查询 Tab 选用的连接 id（表预览 Tab 以 tablePreviews.connId 为准）。 */
  connId: string;
  sql: string;
  database: string;
  /** 上次光标位置，表预览模式无编辑器焦点时 ⌘+Enter 用此 offset 取语句。 */
  cursorOffset: number;
  result: QueryResult | null;
  error: string | null;
  elapsed: number | null;
  running: boolean;
  /** 当前结果页（0-based），翻页时按 lastExecutedSql 重新查询。 */
  resultPage: number;
  /** 最近一次成功执行并展示结果的 SQL。 */
  lastExecutedSql: string | null;
  /** 当前页是否可能还有后续数据（返回行数达到 pageSize 时为 true）。 */
  resultHasMore: boolean;
};

export const DEFAULT_PAGE_SIZE = 100;
/** @deprecated 查询结果分页改由设置页 databaseQueryPageSize 控制；保留供旧文案兼容。 */
export const DEFAULT_QUERY_LIMIT = 1000;
export const DEFAULT_SQL = `SELECT version();`;

/** 无总行数时估算分页 totalRows，以支持「下一页 / 末页」按钮。 */
export function estimateSqlResultTotalRows(
  page: number,
  pageSize: number,
  rowCount: number,
  hasMore: boolean,
): number {
  const base = page * pageSize + rowCount;
  return hasMore ? base + pageSize : base;
}

/** 未提交的新建行在 tabDirtyRows 中的 key 前缀 */
export const NEW_ROW_KEY_PREFIX = "__new__:";
/** 预览网格行对象上标记 pending insert 的内部字段（非表列） */
export const PENDING_INSERT_ROW_KEY = "__pendingRowKey";

export function createDefaultTablePreviewState(): TablePreviewState {
  return {
    loading: false,
    error: null,
    data: null,
    totalRows: 0,
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    sort: null,
    filter: null,
  };
}

/**
 * 按 db_type 转义列名引号，返回可直接拼入 `ORDER BY` 的子句（如 \`col\` ASC）。
 * 仅用于本模块已通过 schema 反射拿到的列名；不接受外部输入以避免注入。
 */
export function buildOrderByClause(
  sort: SortState,
  dbType: string,
): string {
  const quote = dbType.toLowerCase() === "mysql" || dbType.toLowerCase() === "mariadb"
    ? "`"
    : '"';
  const safe = sort.column.replace(quote, "");
  return `${quote}${safe}${quote} ${sort.direction.toUpperCase()}`;
}

export function createDefaultSqlTabState(database = "", connId = ""): SqlTabState {
  return {
    connId,
    sql: DEFAULT_SQL,
    database,
    cursorOffset: 0,
    result: null,
    error: null,
    elapsed: 0,
    running: false,
    resultPage: 0,
    lastExecutedSql: null,
    resultHasMore: false,
  };
}

/** 解析 Tab 实际使用的连接 id（表预览优先）。 */
export function resolveSqlTabConnectionId(
  tabId: string,
  sqlTabStates: Record<string, SqlTabState>,
  tablePreviews: Record<string, TablePreviewState>,
): string {
  return tablePreviews[tabId]?.connId ?? sqlTabStates[tabId]?.connId ?? "";
}

/** 根据工作区 Tab 解析侧栏联动用的连接 id。 */
export function resolveConnIdForWorkspaceTab(
  tab: DbWorkspaceTab | undefined,
  tabStates: {
    sqlTabStates: Record<string, SqlTabState>;
    tablePreviews: Record<string, TablePreviewState>;
  },
): string | null {
  if (!tab) {
    return null;
  }
  if (tab.kind === "database" || tab.kind === "connection" || tab.kind === "designer" || tab.kind === "redis-query") {
    return tab.connId;
  }
  if (tab.kind === "sql") {
    const connId = resolveSqlTabConnectionId(
      tab.id,
      tabStates.sqlTabStates,
      tabStates.tablePreviews,
    );
    return connId || null;
  }
  return null;
}

export function tabModeToEditorOpenMode(mode: "data" | "sql"): SqlEditorOpenMode {
  return mode === "data" ? "table" : "query";
}

export function rowsToRecord(
  columns: string[],
  rows: unknown[][],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj;
  });
}

export type { DbColumnMeta };
