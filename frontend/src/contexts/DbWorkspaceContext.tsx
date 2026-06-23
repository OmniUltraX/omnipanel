import { createContext, useContext, type ReactNode } from "react";
import type {
  SqlTabState,
  TablePreviewState,
  DbColumnMeta,
  SortState,
} from "../modules/database/dbWorkspaceState";
import type { DbWorkspaceTab } from "../modules/database/workspaceTabs";
import type { DbConnectionConfig } from "../modules/database/api";
import type { DatabaseSchema } from "../modules/database/types";
import type { SqlEditorOpenMode } from "../modules/database/SqlEditor";
import type { SchemaTableSelection } from "../modules/database/SchemaBrowser";

export type DbTabAction = {
  kind: "refresh" | "page" | "close" | "sort";
  tabId: string;
  page?: number;
  sort?: SortState | null;
};

/** 工作区共享状态与操作（不含 activeTabId，切换 Tab 时不触发 Panel reconcile）。 */
export interface DbWorkspaceStateContextValue {
  tabs: DbWorkspaceTab[];
  closeTab: (id: string) => void;
  runQuery: (sqlOverride?: string, tabIdOverride?: string) => Promise<void>;
  updateSqlTabState: (id: string, patch: Partial<SqlTabState>) => void;
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
  handleCellEdit: (
    tabId: string,
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
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
  resolveConnection: (connId: string) => DbConnectionConfig | null;
  connectionsLoading: boolean;
  selectTable: (selection: SchemaTableSelection) => void;
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableColumnMeta: Record<string, DbColumnMeta[]>;
  tabModes: Record<string, "data" | "sql">;
  setTabMode: (id: string, mode: "data" | "sql") => void;
  tabDirtyRows: Record<string, Record<string, Record<string, unknown>>>;
  committingTabs: Set<string>;
  commitTabDirty: (tabId: string) => Promise<void>;
  openExportMenu: (x: number, y: number, tabId: string) => void;
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

/** 底部镜像 / 外部同步用的完整快照（含 activeTabId、activeTableKey）。 */
export type DbWorkspaceMirrorContextValue = DbWorkspaceStateContextValue &
  DbWorkspaceActiveTabContextValue & {
    activeTableKey: string | null;
  };

/** @deprecated 镜像与旧代码兼容别名 */
export type DbWorkspaceContextValue = DbWorkspaceMirrorContextValue;

const StateCtx = createContext<DbWorkspaceStateContextValue | null>(null);
const ActiveTabCtx = createContext<DbWorkspaceActiveTabContextValue | null>(null);

export function DbWorkspaceProviders({
  state,
  activeTab,
  children,
}: {
  state: DbWorkspaceStateContextValue;
  activeTab: DbWorkspaceActiveTabContextValue;
  children: ReactNode;
}) {
  return (
    <StateCtx.Provider value={state}>
      <ActiveTabCtx.Provider value={activeTab}>{children}</ActiveTabCtx.Provider>
    </StateCtx.Provider>
  );
}

/** 镜像 Tab 等场景：从完整快照注入双 Context。 */
export function DbWorkspaceMirrorProvider({
  value,
  children,
}: {
  value: DbWorkspaceMirrorContextValue;
  children: ReactNode;
}) {
  const {
    activeTabId,
    setActiveTabId,
    activeTableKey: _activeTableKey,
    ...state
  } = value;
  return (
    <DbWorkspaceProviders
      state={state}
      activeTab={{ activeTabId, setActiveTabId }}
    >
      {children}
    </DbWorkspaceProviders>
  );
}

/** @deprecated 请使用 DbWorkspaceProviders；保留以兼容镜像注入。 */
export function DbWorkspaceProvider({
  value,
  children,
}: {
  value: DbWorkspaceMirrorContextValue;
  children: ReactNode;
}) {
  return <DbWorkspaceMirrorProvider value={value}>{children}</DbWorkspaceMirrorProvider>;
}

export function useDbWorkspace(): DbWorkspaceStateContextValue {
  const v = useContext(StateCtx);
  if (!v) {
    throw new Error("useDbWorkspace must be used inside DbWorkspaceProviders");
  }
  return v;
}

export function useDbWorkspaceActiveTab(): DbWorkspaceActiveTabContextValue {
  const v = useContext(ActiveTabCtx);
  if (!v) {
    throw new Error("useDbWorkspaceActiveTab must be used inside DbWorkspaceProviders");
  }
  return v;
}

export function useDbWorkspaceActiveTabId(): string {
  return useDbWorkspaceActiveTab().activeTabId;
}
