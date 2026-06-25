
export type SqlWorkspaceTab = {
  id: string;
  kind: "sql";
  label: string;
  /** 侧栏 SQL 文件树中的文件 id，用于持久化连接/库绑定。 */
  sqlFileId?: string;
  /** 是否仅在底部工作区中显示（例如移动到工作区后） */
  workspaceOnly?: boolean;
};

export type TablePreviewWorkspaceTab = {
  id: string;
  kind: "table";
  label: string;
  connId: string;
  dbName: string;
  tableName: string;
  workspaceOnly?: boolean;
};

export type DatabaseListWorkspaceTab = {
  id: string;
  kind: "database";
  label: string;
  connId: string;
  dbName: string;
  workspaceOnly?: boolean;
};

export type TableDesignerWorkspaceTab = {
  id: string;
  kind: "designer";
  label: string;
  connId: string;
  dbName: string;
  tableName: string;
  workspaceOnly?: boolean;
};

export type ConnectionInfoWorkspaceTab = {
  id: string;
  kind: "connection";
  label: string;
  connId: string;
  workspaceOnly?: boolean;
};

export type RedisQueryWorkspaceTab = {
  id: string;
  kind: "redis-query";
  label: string;
  connId: string;
  /** 从侧栏点选具体库时锁定；点连接时为空 */
  dbName?: string;
  workspaceOnly?: boolean;
};

export type DbWorkspaceTab =
  | SqlWorkspaceTab
  | TablePreviewWorkspaceTab
  | DatabaseListWorkspaceTab
  | TableDesignerWorkspaceTab
  | ConnectionInfoWorkspaceTab
  | RedisQueryWorkspaceTab;

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

/** 模块功能区 Dock 中可见的 Tab（排除已移入工程工作区的 Tab） */
export function isModuleDockTab(tab: DbWorkspaceTab): boolean {
  return !tab.workspaceOnly;
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
      isModuleDockTab(tab) &&
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
      isModuleDockTab(tab) &&
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
      isModuleDockTab(tab) &&
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
      isModuleDockTab(tab) &&
      tab.kind === "table" &&
      tab.connId === connId &&
      tab.dbName === dbName &&
      tab.tableName === tableName,
  )?.id;
}
