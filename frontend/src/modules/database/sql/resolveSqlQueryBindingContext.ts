import type { DbConnectionConfig } from "../api";
import { parseDatabaseNodeId, parseTableNodeId } from "../schema/schemaTreeIds";
import type { DbWorkspaceTab } from "../workspace/workspaceTabs";
import { isConnectionEnabled } from "../api";

export type SqlQueryBindingContext = {
  connId: string;
  database: string;
};

/**
 * 解析「当前定位」应绑定的连接与库：工作区 Tab、侧栏树焦点、SQL Tab 上下文。
 */
export function resolveSqlQueryBindingContext(options: {
  connections: DbConnectionConfig[];
  activeWorkspaceTab: DbWorkspaceTab | null | undefined;
  activeConnId: string | null;
  activeDatabaseKey: string | null;
  activeTableKey: string | null;
  sqlTabConnDb: { connId: string; database: string } | null;
}): SqlQueryBindingContext | null {
  const {
    connections,
    activeWorkspaceTab,
    activeConnId,
    activeDatabaseKey,
    activeTableKey,
    sqlTabConnDb,
  } = options;

  if (activeWorkspaceTab) {
    const tab = activeWorkspaceTab;
    if (
      tab.kind === "table" ||
      tab.kind === "designer" ||
      tab.kind === "database" ||
      tab.kind === "redis-query"
    ) {
      return { connId: tab.connId, database: tab.dbName };
    }
  }

  if (activeTableKey) {
    const parsed = parseTableNodeId(activeTableKey);
    if (parsed) {
      return { connId: parsed.connId, database: parsed.dbName };
    }
  }

  if (activeDatabaseKey) {
    const parsed = parseDatabaseNodeId(activeDatabaseKey);
    if (parsed) {
      return { connId: parsed.connId, database: parsed.dbName };
    }
  }

  if (sqlTabConnDb?.connId && sqlTabConnDb.database.trim()) {
    return { connId: sqlTabConnDb.connId, database: sqlTabConnDb.database.trim() };
  }

  const connId =
    activeConnId ?? connections.find((conn) => isConnectionEnabled(conn))?.id ?? null;
  if (!connId) {
    return null;
  }
  const connection = connections.find((conn) => conn.id === connId);
  if (!connection) {
    return null;
  }

  if (activeDatabaseKey) {
    const parsed = parseDatabaseNodeId(activeDatabaseKey);
    if (parsed && parsed.connId === connId) {
      return { connId, database: parsed.dbName };
    }
  }

  return { connId, database: connection.database?.trim() ?? "" };
}

export function formatSqlFileBindingMeta(
  file: { connId?: string; database?: string },
  connections: readonly DbConnectionConfig[],
): string | null {
  const connName = file.connId
    ? connections.find((conn) => conn.id === file.connId)?.name?.trim()
    : "";
  const database = file.database?.trim() ?? "";
  if (connName && database) {
    return `${connName} · ${database}`;
  }
  if (connName) {
    return connName;
  }
  if (database) {
    return database;
  }
  return null;
}
