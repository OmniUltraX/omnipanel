export type SqlWorkspaceTab = {
  id: string;
  kind: "sql";
  label: string;
};

export function makeSqlTabId(): string {
  return `sql:${Date.now()}`;
}

export function makeSqlTabLabel(sqlTabCount: number): string {
  return sqlTabCount <= 1 ? "SQL" : `SQL ${sqlTabCount}`;
}

export type TableWorkspaceTab = {
  id: string;
  kind: "table";
  connId: string;
  dbName: string;
  tableName: string;
  label: string;
};

export type DatabaseWorkspaceTab = SqlWorkspaceTab | TableWorkspaceTab;

export function makeTableTabId(connId: string, dbName: string, tableName: string) {
  return `table:${connId}:${dbName}:${tableName}`;
}

export function makeTableTabLabel(dbName: string, tableName: string) {
  return `${dbName}.${tableName}`;
}
