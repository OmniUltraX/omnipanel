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

export function makeTableTabLabel(dbName: string, tableName: string) {
  return `${dbName}.${tableName}`;
}
