import type { DbConnectionConfig } from "../api";
import { isConnectionEnabled } from "../api";
import type { SqlTabState, TablePreviewState } from "../dbWorkspaceState";
import type { DbWorkspaceTab } from "../workspaceTabs";
import type {
  DatabaseConnectionContext,
  DatabaseModuleContext,
} from "./types";

export function toDatabaseConnectionContext(
  connection: DbConnectionConfig,
): DatabaseConnectionContext {
  return {
    id: connection.id,
    name: connection.name,
    dbType: connection.db_type,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    defaultDatabase: connection.database,
    ssl: connection.ssl,
    group: connection.group,
    status: connection.status,
    enabled: isConnectionEnabled(connection),
  };
}

/**
 * 从数据库面板当前 UI 状态解析 AI 上下文。
 * 仅包含连接与数据库，不包含表、视图等更深层级。
 */
export function resolveDatabaseModuleContext(
  connections: DbConnectionConfig[],
  activeConnId: string | null,
  activeWorkspaceTab: DbWorkspaceTab | null,
  sqlTabStates: Record<string, SqlTabState>,
  tablePreviews: Record<string, TablePreviewState>,
): DatabaseModuleContext {
  let connId = activeConnId;
  let database: string | null = null;

  if (activeWorkspaceTab) {
    switch (activeWorkspaceTab.kind) {
      case "connection":
        connId = activeWorkspaceTab.connId;
        break;
      case "database":
        connId = activeWorkspaceTab.connId;
        database = activeWorkspaceTab.dbName;
        break;
      case "designer":
        connId = activeWorkspaceTab.connId;
        database = activeWorkspaceTab.dbName;
        break;
      case "sql": {
        const preview = tablePreviews[activeWorkspaceTab.id];
        if (preview?.connId) {
          connId = preview.connId;
        }
        if (preview?.dbName) {
          database = preview.dbName;
        } else {
          const tabState = sqlTabStates[activeWorkspaceTab.id];
          if (tabState?.connId) {
            connId = tabState.connId;
          }
          const db = tabState?.database?.trim();
          database = db ? db : null;
        }
        break;
      }
      case "table":
      case "redis-query":
        break;
    }
  }

  const connection =
    connId != null
      ? (connections.find((item) => item.id === connId) ?? null)
      : null;

  return {
    connection: connection ? toDatabaseConnectionContext(connection) : null,
    database,
  };
}
