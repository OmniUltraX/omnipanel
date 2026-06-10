import { createContext, useContext } from "react";
import type {
  SqlWorkspaceTab,
  SqlTabState,
  TablePreviewState,
  DbColumnMeta,
} from "../modules/database/dbWorkspaceState";
import type { DbConnectionConfig } from "../modules/database/api";
import type { DatabaseSchema } from "../modules/database/types";
import type { SqlEditorOpenMode } from "../modules/database/SqlEditor";

export type DbTabAction = {
  kind: "refresh" | "page" | "close";
  tabId: string;
  page?: number;
};

export interface DbWorkspaceContextValue {
  // 共享引用
  tabs: SqlWorkspaceTab[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;

  // 标签操作
  closeTab: (id: string) => void;

  // 编辑器 / SQL 执行
  runQuery: (sqlOverride?: string, tabIdOverride?: string) => Promise<void>;
  updateSqlTabState: (id: string, patch: Partial<SqlTabState>) => void;

  // 表预览
  refreshTablePreview: (
    tabId: string,
    connId: string,
    dbName: string,
    tableName: string,
  ) => Promise<void> | void;
  goToPage: (
    tabId: string,
    connId: string,
    dbName: string,
    tableName: string,
    page: number,
  ) => void;
  requestTabAction: (action: DbTabAction) => void;
  handleCellEdit: (
    tabId: string,
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
  ) => void;

  // 状态字典 (by tabId)
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableColumnMeta: Record<string, DbColumnMeta[]>;
  tabModes: Record<string, "data" | "sql">;
  setTabMode: (id: string, mode: "data" | "sql") => void;
  tabDirtyRows: Record<string, Record<string, Record<string, unknown>>>;
  committingTabs: Set<string>;
  commitTabDirty: (tabId: string) => Promise<void>;
  openExportMenu: (x: number, y: number, tabId: string) => void;

  // 连接 / 数据库 / schema
  activeConn: DbConnectionConfig | null;
  groupConnections: DbConnectionConfig[];
  databasesByConnId: Record<string, string[]>;
  databasesForActiveConn: string[];
  schemaByKey: Record<string, DatabaseSchema>;
  schemaLoadingKey: string | null;
  setActiveConnId: (id: string | null) => void;
  sqlCompletionSchemas: DatabaseSchema[];

  // 工具
  connectionForSql: DbConnectionConfig | null;
  rowsToRecord: (cols: string[], rows: unknown[][]) => Record<string, unknown>[];
  tabModeToEditorOpenMode: (mode: "data" | "sql") => SqlEditorOpenMode;
}

const Ctx = createContext<DbWorkspaceContextValue | null>(null);

export const DbWorkspaceProvider = Ctx.Provider;

export function useDbWorkspace(): DbWorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useDbWorkspace must be used inside <DbWorkspaceProvider>");
  }
  return v;
}
