import {
  makeDatabaseTabKey,
  makeTableTabKey,
  type DbWorkspaceTab,
} from "../workspace/workspaceTabs";
import {
  resolveConnIdForWorkspaceTab,
  resolveSqlTabConnectionId,
  type SqlTabState,
  type TablePreviewState,
} from "../workspace/dbWorkspaceState";

export type DbSidebarLinkageSnapshot = {
  activeConnId: string | null;
  activeDatabaseKey: string | null;
  activeTableKey: string | null;
};

/** 由工作区 Tab 即时解析侧栏联动目标（不依赖 React state，可供 pointerdown / flushSync 使用） */
export function resolveDbSidebarLinkageFromTab(
  tab: DbWorkspaceTab | null | undefined,
  tabStates: {
    sqlTabStates: Record<string, SqlTabState>;
    tablePreviews: Record<string, TablePreviewState>;
  },
): DbSidebarLinkageSnapshot {
  if (!tab) {
    return { activeConnId: null, activeDatabaseKey: null, activeTableKey: null };
  }

  const activeConnId = resolveConnIdForWorkspaceTab(tab, tabStates);

  if (tab.kind === "table") {
    return {
      activeConnId,
      activeDatabaseKey: makeDatabaseTabKey(tab.connId, tab.dbName),
      activeTableKey: makeTableTabKey(tab.connId, tab.dbName, tab.tableName),
    };
  }

  if (tab.kind === "designer") {
    return {
      activeConnId,
      activeDatabaseKey: makeDatabaseTabKey(tab.connId, tab.dbName),
      activeTableKey: makeTableTabKey(tab.connId, tab.dbName, tab.tableName),
    };
  }

  if (tab.kind === "database" || tab.kind === "redis-query") {
    return {
      activeConnId,
      activeDatabaseKey: makeDatabaseTabKey(tab.connId, tab.dbName),
      activeTableKey: null,
    };
  }

  if (tab.kind === "sql") {
    const preview = tabStates.tablePreviews[tab.id];
    if (preview?.connId && preview.dbName && preview.tableName) {
      return {
        activeConnId: preview.connId,
        activeDatabaseKey: makeDatabaseTabKey(preview.connId, preview.dbName),
        activeTableKey: makeTableTabKey(preview.connId, preview.dbName, preview.tableName),
      };
    }
    const sqlState = tabStates.sqlTabStates[tab.id];
    const sqlConn =
      sqlState?.connId ||
      resolveSqlTabConnectionId(tab.id, tabStates.sqlTabStates, tabStates.tablePreviews);
    const sqlDb = sqlState?.database?.trim() ?? "";
    if (sqlConn && sqlDb) {
      return {
        activeConnId: sqlConn,
        activeDatabaseKey: makeDatabaseTabKey(sqlConn, sqlDb),
        activeTableKey: null,
      };
    }
    return { activeConnId: activeConnId, activeDatabaseKey: null, activeTableKey: null };
  }

  return { activeConnId, activeDatabaseKey: null, activeTableKey: null };
}
