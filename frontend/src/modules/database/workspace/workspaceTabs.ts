/** Schema 侧栏双击打开面板；默认常驻标签。`preview` 仅兼容旧会话数据。 */
export type SchemaDockOpenMode = "preview" | "permanent";

export type SqlWorkspaceTab = {
  id: string;
  kind: "sql";
  label: string;
  /** 侧栏 SQL 文件树中的文件 id，用于持久化连接/库绑定。 */
  sqlFileId?: string;
  /** 是否仅在底部工作区中显示（例如移动到工作区后） */
  workspaceOnly?: boolean;
  /** @deprecated 旧预览槽位；新打开为常驻 */
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

export type SlowQueryLogWorkspaceTab = {
  id: string;
  kind: "slow-query";
  label: string;
  connId: string;
  sshConnectionId: string;
  logFilePath: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type BinlogWorkspaceTab = {
  id: string;
  kind: "binlog";
  label: string;
  connId: string;
  sshConnectionId: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
  logBinBasename?: string;
  binlogFormat?: string;
  binlogRowImage?: string;
  flashbackCapable?: boolean;
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

export type TreeChartWorkspaceTab = {
  id: string;
  kind: "tree-chart";
  label: string;
  treeChartFileId: string;
  workspaceOnly?: boolean;
  preview?: boolean;
};

export type DbWorkspaceTab =
  | SqlWorkspaceTab
  | TablePreviewWorkspaceTab
  | DatabaseListWorkspaceTab
  | TableDesignerWorkspaceTab
  | ConnectionInfoWorkspaceTab
  | SlowQueryLogWorkspaceTab
  | BinlogWorkspaceTab
  | RedisQueryWorkspaceTab
  | ToolboxWorkspaceTab
  | TreeChartWorkspaceTab;

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

export function isSlowQueryLogTab(tab: DbWorkspaceTab): tab is SlowQueryLogWorkspaceTab {
  return tab.kind === "slow-query";
}

export function isBinlogTab(tab: DbWorkspaceTab): tab is BinlogWorkspaceTab {
  return tab.kind === "binlog";
}

export function isRedisQueryTab(tab: DbWorkspaceTab): tab is RedisQueryWorkspaceTab {
  return tab.kind === "redis-query";
}

export function isToolboxTab(tab: DbWorkspaceTab | null | undefined): tab is ToolboxWorkspaceTab {
  return tab?.kind === "toolbox";
}

export function isTreeChartTab(tab: DbWorkspaceTab | null | undefined): tab is TreeChartWorkspaceTab {
  return tab?.kind === "tree-chart";
}

export function syncTaskDockTabId(taskId: string): string {
  return `synctask:${taskId}`;
}

export function makeSyncTaskWorkspaceTab(
  task: {
    id: string;
    name: string;
    kind: ToolboxWorkspaceTab["toolboxTab"];
  },
  actionLabel?: string,
): ToolboxWorkspaceTab {
  const action =
    actionLabel ?? (task.kind === "schemaSync" ? "结构同步" : "数据同步");
  return {
    id: syncTaskDockTabId(task.id),
    kind: "toolbox",
    toolboxTab: task.kind,
    syncTaskId: task.id,
    label: formatDbWorkspaceTabLabel({
      action,
      table: task.name,
    }),
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

export function makeSlowQueryLogTabId(): string {
  return `slowlog:${Date.now()}`;
}

export function makeBinlogTabId(): string {
  return `binlog:${Date.now()}`;
}

export function makeRedisQueryTabId(): string {
  return `redisq:${Date.now()}`;
}

export function makeTreeChartTabId(): string {
  return `treechart:${Date.now()}`;
}

/**
 * 统一 Tab 标题：段之间用 @ 连接（由细到粗，缺省段省略）
 * 例：users@mydb@本地MySQL、慢查询@本地MySQL、mydb@本地MySQL
 */
export function formatDbWorkspaceTabLabel(parts: {
  action?: string | null;
  table?: string | null;
  database?: string | null;
  connection?: string | null;
}): string {
  const segments: string[] = [];
  const action = parts.action?.trim();
  if (action) {
    segments.push(action);
  }
  const table = parts.table?.trim();
  if (table) {
    segments.push(table);
  }
  const database = parts.database?.trim();
  if (database) {
    segments.push(database);
  }
  const connection = parts.connection?.trim();
  if (connection) {
    segments.push(connection);
  }
  return segments.join("@");
}

export function makeTreeChartTabLabel(action: string, fileLabel?: string | null): string {
  return formatDbWorkspaceTabLabel({
    action,
    table: fileLabel?.trim() || null,
  });
}

/** 表设计：users@mydb@连接 */
export function makeTableDesignerTabLabel(
  tableName: string,
  dbName: string,
  connectionName: string,
): string {
  return formatDbWorkspaceTabLabel({
    table: tableName,
    database: dbName,
    connection: connectionName,
  });
}

/**
 * SQL Tab：
 * - 从表打开 → users@mydb@连接
 * - 文件 → query1@mydb@连接
 */
export function makeSqlTabLabel(opts: {
  action?: string | null;
  table?: string | null;
  database?: string | null;
  connection?: string | null;
}): string {
  return formatDbWorkspaceTabLabel({
    action: opts.action,
    table: opts.table,
    database: opts.database,
    connection: opts.connection,
  });
}

/** 表数据：users@mydb@连接 */
export function makeTableTabLabel(
  tableName: string,
  dbName: string,
  connectionName: string,
): string {
  return formatDbWorkspaceTabLabel({
    table: tableName,
    database: dbName,
    connection: connectionName,
  });
}

/** 库列表 / Redis 库：mydb@连接 */
export function makeDatabaseListTabLabel(
  dbName: string,
  connectionName: string,
): string {
  return formatDbWorkspaceTabLabel({
    database: dbName,
    connection: connectionName,
  });
}

/** 连接信息：仅连接名 */
export function makeConnectionTabLabel(connectionName: string): string {
  return formatDbWorkspaceTabLabel({
    connection: connectionName,
  });
}

/** 慢查询 / 二进制等：操作@连接 */
export function makeConnectionScopedTabLabel(
  action: string,
  connectionName: string,
  database?: string | null,
): string {
  return formatDbWorkspaceTabLabel({
    action,
    database,
    connection: connectionName,
  });
}

/** 连接信息 Tab 唯一键 */
export function makeConnectionTabKey(connId: string): string {
  return `conn:${connId}`;
}

/** 慢查询日志 Tab 唯一键 */
export function makeSlowQueryLogTabKey(connId: string): string {
  return `slowlog:${connId}`;
}

/** Binlog Tab 唯一键 */
export function makeBinlogTabKey(connId: string): string {
  return `binlog:${connId}`;
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

/** 查找已打开指定树图文件的工作区 Tab */
export function findTabIdForTreeChartFile(
  tabs: DbWorkspaceTab[],
  fileId: string,
): string | undefined {
  return tabs.find(
    (tab) => isModuleDockTab(tab) && tab.kind === "tree-chart" && tab.treeChartFileId === fileId,
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

/** 查找已打开指定连接的慢查询日志 Tab */
export function findTabIdForSlowQueryLog(
  tabs: DbWorkspaceTab[],
  connId: string,
): string | undefined {
  return tabs.find(
    (tab) => isModuleDockTab(tab) && tab.kind === "slow-query" && tab.connId === connId,
  )?.id;
}

/** 查找已打开指定连接的 Binlog Tab */
export function findTabIdForBinlog(
  tabs: DbWorkspaceTab[],
  connId: string,
): string | undefined {
  return tabs.find(
    (tab) => isModuleDockTab(tab) && tab.kind === "binlog" && tab.connId === connId,
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
