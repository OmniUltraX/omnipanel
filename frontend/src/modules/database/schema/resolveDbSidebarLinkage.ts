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
      activeDatabaseKey: tab.dbName
        ? makeDatabaseTabKey(tab.connId, tab.dbName)
        : null,
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

/**
 * 收集所有已打开工作区 Tab 对应的树节点 id 集合。
 * 用于在连接树上标记"已打开 Tab"的节点（非 active 的弱标记）。
 *
 * Tab key 与 tree node id 同形（`db:...` / `tbl:...`），可直接用。
 * 连接节点不进 Tab，不收集。
 */
export function collectOpenTabNodeIds(
  tabs: DbWorkspaceTab[],
  tabStates: {
    sqlTabStates: Record<string, SqlTabState>;
    tablePreviews: Record<string, TablePreviewState>;
  },
): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind === "table" || tab.kind === "designer") {
      ids.add(makeTableTabKey(tab.connId, tab.dbName, tab.tableName));
      ids.add(makeDatabaseTabKey(tab.connId, tab.dbName));
      continue;
    }
    if (tab.kind === "database" || tab.kind === "redis-query") {
      if (tab.dbName) {
        ids.add(makeDatabaseTabKey(tab.connId, tab.dbName));
      }
      continue;
    }
    if (tab.kind === "sql") {
      const preview = tabStates.tablePreviews[tab.id];
      if (preview?.connId && preview.dbName && preview.tableName) {
        ids.add(makeTableTabKey(preview.connId, preview.dbName, preview.tableName));
        ids.add(makeDatabaseTabKey(preview.connId, preview.dbName));
        continue;
      }
      const sqlState = tabStates.sqlTabStates[tab.id];
      const sqlConn =
        sqlState?.connId ||
        resolveSqlTabConnectionId(tab.id, tabStates.sqlTabStates, tabStates.tablePreviews);
      const sqlDb = sqlState?.database?.trim() ?? "";
      if (sqlConn && sqlDb) {
        ids.add(makeDatabaseTabKey(sqlConn, sqlDb));
      }
      continue;
    }
  }
  return ids;
}
