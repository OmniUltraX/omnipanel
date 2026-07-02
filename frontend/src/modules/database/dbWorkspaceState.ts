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
  /** 隐藏的列名；空数组表示全部显示 */
  hiddenColumns: string[];
  /** 是否开启行列转置 */
  transposed: boolean;
};

export type TableDesignerTabState = {
  model: TableDesignerModel;
  baseline: TableDesignerModel;
};

export type SqlResultSession = {
  id: string;
  sql: string;
  result: QueryResult | null;
  error: string | null;
  elapsed: number | null;
  running: boolean;
  resultPage: number;
  resultHasMore: boolean;
  /** 固定后不会被后续查询覆盖；未固定时为临时结果。 */
  pinned?: boolean;
};

export type SqlTabState = {
  /** 查询 Tab 选用的连接 id（表预览 Tab 以 tablePreviews.connId 为准）。 */
  connId: string;
  sql: string;
  database: string;
  /** 上次光标位置，表预览模式无编辑器焦点时 ⌘+Enter 用此 offset 取语句。 */
  cursorOffset: number;
  /** 工具栏校验类错误（非查询执行错误） */
  error: string | null;
  /** 是否有查询正在执行 */
  running: boolean;
  /** 当前可中断的查询 runId（与后端 db_cancel_query 配对） */
  activeQueryRunId: string | null;
  /** 每次执行对应一个结果会话 */
  resultSessions: SqlResultSession[];
  activeResultSessionId: string | null;
  /** @deprecated 旧版单结果字段，仅兼容读取 */
  result?: QueryResult | null;
  elapsed?: number | null;
  resultPage?: number;
  lastExecutedSql?: string | null;
  resultHasMore?: boolean;
};

export const DEFAULT_PAGE_SIZE = 100;
/** @deprecated 查询结果分页改由设置页 databaseQueryPageSize 控制；保留供旧文案兼容。 */
export const DEFAULT_QUERY_LIMIT = 1000;
export const DEFAULT_SQL = `SELECT version();`;

/** 表预览 COUNT 未完成时，根据当前页行数估算 totalRows。 */
export function estimateTablePreviewTotalRows(
  page: number,
  pageSize: number,
  rowCount: number,
): number {
  const hasMore = rowCount >= pageSize;
  const base = page * pageSize + rowCount;
  return hasMore ? base + pageSize : base;
}

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
/** 待删除行在 tabDirtyRows 中的 key 前缀（后缀为 resolvePreviewRowKey 生成的行键） */
export const DELETED_ROW_KEY_PREFIX = "__delete__:";
/** 预览网格行对象上标记 pending insert 的内部字段（非表列） */
export const PENDING_INSERT_ROW_KEY = "__pendingRowKey";

export function isDeletedRowDirtyKey(key: string): boolean {
  return key.startsWith(DELETED_ROW_KEY_PREFIX);
}

export function resolvePreviewRowKey(
  row: Record<string, unknown>,
  pkCols: { name: string }[],
): string {
  const pendingKey = row[PENDING_INSERT_ROW_KEY];
  if (typeof pendingKey === "string") return pendingKey;
  if (pkCols.length === 0) return "";
  return pkCols
    .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
    .join("&");
}

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
    hiddenColumns: [],
    transposed: false,
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

export function makeSqlResultSessionId(): string {
  return `sqlsess:${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function makeSqlResultSessionLabel(index: number): string {
  return `Result${index}`;
}

export function findTemporarySqlResultSession(
  sessions: SqlResultSession[],
): SqlResultSession | undefined {
  return sessions.find((session) => !session.pinned);
}

export function createSqlResultSession(sql: string, pinned = false): SqlResultSession {
  return {
    id: makeSqlResultSessionId(),
    sql,
    result: null,
    error: null,
    elapsed: null,
    running: true,
    resultPage: 0,
    resultHasMore: false,
    pinned,
  };
}

/** 重置临时结果会话以承载新查询。 */
export function reuseTemporarySqlResultSession(
  session: SqlResultSession,
  sql: string,
): SqlResultSession {
  return {
    ...session,
    sql,
    result: null,
    error: null,
    elapsed: null,
    running: true,
    resultPage: 0,
    resultHasMore: false,
  };
}

export function createDefaultSqlTabState(database = "", connId = ""): SqlTabState {
  return {
    connId,
    sql: DEFAULT_SQL,
    database,
    cursorOffset: 0,
    error: null,
    running: false,
    activeQueryRunId: null,
    resultSessions: [],
    activeResultSessionId: null,
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
  if (tab.kind === "table" || tab.kind === "database" || tab.kind === "connection" || tab.kind === "designer" || tab.kind === "redis-query") {
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
