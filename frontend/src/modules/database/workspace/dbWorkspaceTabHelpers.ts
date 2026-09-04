import type { DbSqlTabStateSnapshot } from "./dbWorkspaceSession";
import type { DbWorkspaceTab } from "./workspaceTabs";
import { createDefaultSqlTabState, type SqlTabState } from "./dbWorkspaceState";

export function tabMatchesTableSelection(
  tab: DbWorkspaceTab,
  connId: string,
  dbName: string,
  tableName: string,
): boolean {
  return (
    tab.kind === "table" &&
    tab.connId === connId &&
    tab.dbName === dbName &&
    tab.tableName === tableName
  );
}

export function tabMatchesDatabaseSelection(
  tab: DbWorkspaceTab,
  connId: string,
  dbName: string,
  isRedis: boolean,
): boolean {
  if (isRedis) {
    return tab.kind === "redis-query" && tab.connId === connId && tab.dbName === dbName;
  }
  return tab.kind === "database" && tab.connId === connId && tab.dbName === dbName;
}

export function tabMatchesConnectionSelection(
  tab: DbWorkspaceTab,
  connId: string,
  _isRedis: boolean,
): boolean {
  return tab.kind === "connection" && tab.connId === connId;
}

export function restoreSqlTabStateFromSnapshot(snap: DbSqlTabStateSnapshot): SqlTabState {
  return {
    ...createDefaultSqlTabState(snap.database, snap.connId ?? ""),
    sql: snap.sql,
    database: snap.database,
    connId: snap.connId ?? "",
    cursorOffset: snap.cursorOffset,
  };
}

export function applyDefaultWorkspaceSession(
  setWorkspaceTabs: (tabs: DbWorkspaceTab[]) => void,
  activateTab: (id: string) => void,
  resetTabWorkspace: () => void,
): void {
  setWorkspaceTabs([]);
  activateTab("");
  resetTabWorkspace();
}

/** 把行主键拼成的字符串（"col=val&col=val"）解析回单列值，rowKey 中空字符串表示 NULL */
export function readRowKeyValue(rowKey: string, colName: string): string {
  for (const part of rowKey.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === colName) {
      return part.slice(eq + 1);
    }
  }
  return "";
}

/** Qdrant point id：数字保持 number，其余按字符串（UUID）。 */
export function parseQdrantPointId(raw: string): string | number | null {
  if (raw === "") return null;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  return raw;
}
