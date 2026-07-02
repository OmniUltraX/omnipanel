import type {
  SqlTabState,
  TablePreviewState,
  DbColumnMeta,
  SortState,
} from "../modules/database/dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import type { DbWorkspaceTab } from "../modules/database/workspaceTabs";
import type { DbConnectionConfig } from "../modules/database/api";
import type { DatabaseSchema } from "../modules/database/types";
import type { SqlEditorOpenMode } from "../modules/database/SqlEditor";
import type { SchemaTableSelection } from "../modules/database/SchemaBrowser";

export type DbTabAction = {
  kind: "refresh" | "page" | "close" | "sort" | "filter";
  tabId: string;
  page?: number;
  sort?: SortState | null;
  filter?: RuleGroupType | null;
};

/** 工作区共享操作与连接级状态（不含 activeTabId / Tab 级快照）。 */
export interface DbWorkspaceSharedContextValue {
  tabs: DbWorkspaceTab[];
  closeTab: (id: string) => void;
  runQuery: (
    sqlOverride?: string,
    tabIdOverride?: string,
    options?: { resultPage?: number; sessionId?: string },
  ) => Promise<void>;
  cancelQuery: (tabIdOverride?: string) => Promise<void>;
  goToQueryResultPage: (tabId: string, page: number, sessionId?: string) => Promise<void>;
  updateSqlTabState: (id: string, patch: Partial<SqlTabState>) => void;
  closeSqlResultSession: (sqlTabId: string, sessionId: string) => void;
  setSqlResultSessionPinned: (sqlTabId: string, sessionId: string, pinned: boolean) => void;
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
  setTableSort: (tabId: string, sort: SortState | null) => void;
  setTableFilter: (tabId: string, filter: RuleGroupType | null) => void;
  setTableGridView: (
    tabId: string,
    patch: Partial<Pick<TablePreviewState, "hiddenColumns" | "transposed">>,
  ) => void;
  handleCellCommit: (
    tabId: string,
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
    value: unknown,
  ) => void;
  handleRowEdit: (
    tabId: string,
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
  ) => void;
  handleCellSetNull: (
    tabId: string,
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
  ) => void;
  handleRowNew: (tabId: string) => void;
  handleRowPaste: (
    tabId: string,
    payload: { values: Record<string, unknown> },
  ) => void;
  handleRowsDelete: (
    tabId: string,
    rows: Array<{ rowIndex: number; row: Record<string, unknown> }>,
  ) => void;
  resolveConnection: (connId: string) => DbConnectionConfig | null;
  connectionsLoading: boolean;
  selectTable: (selection: SchemaTableSelection) => void;
  setTabMode: (id: string, mode: "data" | "sql") => void;
  commitTabDirty: (tabId: string) => Promise<void>;
  openExportMenu: (x: number, y: number, tabId: string, sessionId?: string) => void;
  sqlConnections: DbConnectionConfig[];
  groupConnections: DbConnectionConfig[];
  databasesByConnId: Record<string, string[]>;
  schemaByKey: Record<string, DatabaseSchema>;
  schemaLoadingKey: string | null;
  resolveSqlTabConnection: (tabId: string) => DbConnectionConfig | null;
  getSqlTabDatabases: (tabId: string) => string[];
  getSqlCompletionSchemas: (tabId: string) => DatabaseSchema[];
  connectionForSqlTab: (tabId: string) => DbConnectionConfig | null;
  setSqlTabConnection: (tabId: string, connId: string | null) => void;
  rowsToRecord: (cols: string[], rows: unknown[][]) => Record<string, unknown>[];
  tabModeToEditorOpenMode: (mode: "data" | "sql") => SqlEditorOpenMode;
  saveSqlTab: (tabId?: string) => Promise<void>;
  isSqlTabDirty: (tabId: string) => boolean;
}

export interface DbWorkspaceActiveTabContextValue {
  activeTabId: string;
  setActiveTabId: (id: string) => void;
}

export interface DbWorkspaceProvidersProps {
  state: DbWorkspaceSharedContextValue;
  activeTab: DbWorkspaceActiveTabContextValue;
  children: React.ReactNode;
}

/** Tab 级工作区数据（由 Zustand store 持有；镜像快照单独合并）。 */
export interface DbWorkspaceTabDataContextValue {
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableColumnMeta: Record<string, DbColumnMeta[]>;
  tabModes: Record<string, "data" | "sql">;
  tabDirtyRows: Record<string, Record<string, Record<string, unknown>>>;
  committingTabs: Set<string>;
}

/** 底部镜像 / 外部同步用的完整快照（含 activeTabId、activeTableKey、Tab 级数据）。 */
export type DbWorkspaceMirrorContextValue = DbWorkspaceSharedContextValue &
  DbWorkspaceTabDataContextValue &
  DbWorkspaceActiveTabContextValue & {
    activeTableKey: string | null;
  };

/** @deprecated 镜像与旧代码兼容别名 */
export type DbWorkspaceContextValue = DbWorkspaceMirrorContextValue;
