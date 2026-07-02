/** Schema 单击打开的临时预览 Tab；双击或编辑后变为常驻（无 preview）。 */
export type SchemaDockOpenMode = "preview" | "permanent";

export type SqlWorkspaceTab = {
  id: string;
  kind: "sql";
  label: string;
  /** 侧栏 SQL 文件树中的文件 id，用于持久化连接/库绑定。 */
  sqlFileId?: string;
  /** 是否仅在底部工作区中显示（例如移动到工作区后） */
  workspaceOnly?: boolean;
  /** Schema 单击预览 Tab，标题斜体显示，下次单击其他节点时内容被替换 */
  preview?: boolean;
};

export type TablePreviewWorkspaceTab = {
  id: string;
  kind: "table";
  label: string;
  connId: string;
  dbName: string;
  tableName: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type DatabaseListWorkspaceTab = {
  id: string;
  kind: "database";
  label: string;
  connId: string;
  dbName: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type TableDesignerWorkspaceTab = {
  id: string;
  kind: "designer";
  label: string;
  connId: string;
  dbName: string;
  tableName: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type ConnectionInfoWorkspaceTab = {
  id: string;
  kind: "connection";
  label: string;
  connId: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type RedisQueryWorkspaceTab = {
  id: string;
  kind: "redis-query";
  label: string;
  connId: string;
  /** 从侧栏点选具体库时锁定；点连接时为空 */
  dbName?: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type ToolboxWorkspaceTab = {
  id: string;
  kind: "toolbox";
  /** 数据同步 / 结构同步 */
  toolboxTab: "dataSync" | "schemaSync";
  /** 绑定的同步任务 id */
  syncTaskId: string;
  label: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type DbWorkspaceTab =
  | SqlWorkspaceTab
  | TablePreviewWorkspaceTab
  | DatabaseListWorkspaceTab
  | TableDesignerWorkspaceTab
  | ConnectionInfoWorkspaceTab
  | RedisQueryWorkspaceTab
  | ToolboxWorkspaceTab;

export function isSqlWorkspaceTab(tab: DbWorkspaceTab): tab is SqlWorkspaceTab {
  return tab.kind === "sql";
}

export function isTablePreviewTab(tab: DbWorkspaceTab): tab is TablePreviewWorkspaceTab {
  return tab.kind === "table";
}

export function isDatabaseListTab(tab: DbWorkspaceTab): tab is DatabaseListWorkspaceTab {
  return tab.kind === "database";
}

export function isTableDesignerTab(tab: DbWorkspaceTab): tab is TableDesignerWorkspaceTab {
  return tab.kind === "designer";
}

export function isConnectionInfoTab(tab: DbWorkspaceTab): tab is ConnectionInfoWorkspaceTab {
  return tab.kind === "connection";
}

export function isRedisQueryTab(tab: DbWorkspaceTab): tab is RedisQueryWorkspaceTab {
  return tab.kind === "redis-query";
}

export function isToolboxTab(tab: DbWorkspaceTab | null | undefined): tab is ToolboxWorkspaceTab {
  return tab?.kind === "toolbox";
}

/** @deprecated 旧版全局同步 Tab，会话恢复时会被丢弃 */
export const DATA_SYNC_DOCK_TAB_ID = "toolbox:dataSync";
/** @deprecated 旧版全局同步 Tab，会话恢复时会被丢弃 */
export const SCHEMA_SYNC_DOCK_TAB_ID = "toolbox:schemaSync";

export function syncTaskDockTabId(taskId: string): string {
  return `synctask:${taskId}`;
}

export function makeSyncTaskWorkspaceTab(task: {
  id: string;
  name: string;
  kind: ToolboxWorkspaceTab["toolboxTab"];
}): ToolboxWorkspaceTab {
  return {
    id: syncTaskDockTabId(task.id),
    kind: "toolbox",
    toolboxTab: task.kind,
    syncTaskId: task.id,
    label: task.name,
  };
}

/** 查找已打开的同步任务 Dock Tab */
export function findTabIdForSyncTask(tabs: DbWorkspaceTab[], taskId: string): string | undefined {
  return tabs.find(
    (tab) =>
      isModuleDockTab(tab) &&
      tab.kind === "toolbox" &&
      tab.syncTaskId === taskId,
  )?.id;
}

/** 模块功能区 Dock 中可见的 Tab（排除已移入工程工作区的 Tab） */
export function isModuleDockTab(tab: DbWorkspaceTab): boolean {
  return !tab.workspaceOnly;
}

/** 常驻 Dock Tab（非 Schema 预览 Tab） */
export function isPermanentModuleDockTab(tab: DbWorkspaceTab): boolean {
  return isModuleDockTab(tab) && !tab.preview;
}

/** 当前唯一的 Schema 预览 Tab（单击打开、可被下一次单击替换） */
export function findPreviewDockTab(tabs: DbWorkspaceTab[]): DbWorkspaceTab | undefined {
  return tabs.find((tab) => isModuleDockTab(tab) && tab.preview);
}

export function makeSqlTabId(): string {
  return `sql:${Date.now()}`;
}

export function makeTableTabId(): string {
  return `tbltab:${Date.now()}`;
}

export function makeDatabaseTabId(): string {
  return `dbtab:${Date.now()}`;
}

export function makeDesignerTabId(): string {
  return `design:${Date.now()}`;
}

export function makeConnectionInfoTabId(): string {
  return `conninfo:${Date.now()}`;
}

export function makeRedisQueryTabId(): string {
  return `redisq:${Date.now()}`;
}

export function makeTableDesignerTabLabel(dbName: string, tableName: string): string {
  return `${dbName}.${tableName}`;
}

export function makeSqlTabLabel(sqlTabCount: number): string {
  return sqlTabCount <= 1 ? "SQL" : `SQL ${sqlTabCount}`;
}

export function makeTableTabLabel(dbName: string, tableName: string) {
  return `${dbName}.${tableName}`;
}

/** 连接信息 Tab 唯一键 */
export function makeConnectionTabKey(connId: string): string {
  return `conn:${connId}`;
}

/** 数据库列表 Tab 唯一键：连接 + 库名 */
export function makeDatabaseTabKey(connId: string, dbName: string): string {
  return `db:${connId}:${dbName}`;
}

/** 表 Tab 唯一键：连接 + 库 + 表名 */
export function makeTableTabKey(connId: string, dbName: string, tableName: string): string {
  return `tbl:${connId}:${dbName}:${tableName}`;
}

/** 表设计器 Tab 唯一键 */
export function makeTableDesignerTabKey(connId: string, dbName: string, tableName: string): string {
  return `design:${connId}:${dbName}:${tableName}`;
}

/** 查找已打开的表设计器 Tab */
export function findTabIdForDesigner(
  tabs: DbWorkspaceTab[],
  connId: string,
  dbName: string,
  tableName: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      isPermanentModuleDockTab(tab) &&
      tab.kind === "designer" &&
      tab.connId === connId &&
      tab.dbName === dbName &&
      tab.tableName === tableName,
  )?.id;
}

/** 查找已打开指定 SQL 文件的工作区 Tab */
export function findTabIdForSqlFile(
  tabs: DbWorkspaceTab[],
  fileId: string,
): string | undefined {
  return tabs.find(
    (tab) => isModuleDockTab(tab) && tab.kind === "sql" && tab.sqlFileId === fileId,
  )?.id;
}

/** 查找已打开指定数据库的列表 Tab */
export function findTabIdForDatabase(
  tabs: DbWorkspaceTab[],
  connId: string,
  dbName: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      isPermanentModuleDockTab(tab) &&
      tab.kind === "database" &&
      tab.connId === connId &&
      tab.dbName === dbName,
  )?.id;
}

/** 查找已打开指定连接的连接信息 Tab */
export function findTabIdForConnection(
  tabs: DbWorkspaceTab[],
  connId: string,
): string | undefined {
  return tabs.find(
    (tab) => isModuleDockTab(tab) && tab.kind === "connection" && tab.connId === connId,
  )?.id;
}

/** 查找已打开的 Redis 查询 Tab */
export function findTabIdForRedisQuery(
  tabs: DbWorkspaceTab[],
  connId: string,
  dbName?: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      isPermanentModuleDockTab(tab) &&
      tab.kind === "redis-query" &&
      tab.connId === connId &&
      (tab.dbName ?? "") === (dbName ?? ""),
  )?.id;
}

/** 查找已打开指定表的工作区 Tab，未找到返回 undefined */
export function findTabIdForTable(
  tabs: DbWorkspaceTab[],
  connId: string,
  dbName: string,
  tableName: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      isPermanentModuleDockTab(tab) &&
      tab.kind === "table" &&
      tab.connId === connId &&
      tab.dbName === dbName &&
      tab.tableName === tableName,
  )?.id;
}
