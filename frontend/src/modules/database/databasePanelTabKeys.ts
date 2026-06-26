import type { DbWorkspaceTab } from "./workspaceTabs";
import type { SqlTabState, TablePreviewState } from "./dbWorkspaceState";
import type { DbConnectionConfig } from "./api";

function connectionConfigFingerprint(configs: { id: string }[]): string {
  if (configs.length === 0) {
    return "";
  }
  return configs.map((c) => c.id).join(",");
}

function sqlTabSessionsFingerprint(state: SqlTabState | undefined): string {
  if (!state?.resultSessions?.length) {
    return "0";
  }
  return state.resultSessions
    .map((session) =>
      [
        session.id,
        session.running ? "1" : "0",
        session.error ? "1" : "0",
        session.result ? `${session.result.columns.length}:${session.result.rows.length}` : "0",
        String(session.resultPage ?? 0),
      ].join(":"),
    )
    .join(",");
}

/** 非表预览 SQL Tab 的 volatile 指纹，用于 panel content key 增量失效。 */
export function buildSqlTabPanelKeySeed(
  workspaceTabs: DbWorkspaceTab[],
  state: {
    sqlTabStates: Record<string, SqlTabState>;
  },
): string {
  const parts: string[] = [];
  for (const tab of workspaceTabs) {
    if (tab.kind !== "sql") continue;
    const s = state.sqlTabStates[tab.id];
    parts.push(
      [
        tab.id,
        tab.label,
        tab.sqlFileId ?? "",
        s?.connId ?? "",
        s?.database ?? "",
        s?.running ? "1" : "0",
        s?.error ? "1" : "0",
        sqlTabSessionsFingerprint(s),
        s?.activeResultSessionId ?? "",
      ].join("|"),
    );
  }
  return parts.join(";");
}

export function selectTablePreviewTabIdKey(_state: {
  tablePreviews: Record<string, TablePreviewState>;
}, workspaceTabs: DbWorkspaceTab[]): string {
  const tableTabIds = new Set(
    workspaceTabs.filter((tab) => tab.kind === "table").map((tab) => tab.id),
  );
  return [...tableTabIds].sort().join(",");
}

export function buildDatabasePanelContentKeysByTab(params: {
  workspaceTabs: DbWorkspaceTab[];
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableDesignerStates: Record<string, unknown>;
  connections: DbConnectionConfig[];
}): Record<string, string> {
  const connectionsFingerprint = connectionConfigFingerprint(params.connections);
  const keys: Record<string, string> = {};
  for (const tab of params.workspaceTabs) {
    if (tab.kind === "table") {
      const preview = params.tablePreviews[tab.id];
      keys[tab.id] = [
        tab.connId,
        tab.dbName,
        tab.tableName,
        tab.id,
        preview?.page ?? 0,
        preview?.pageSize ?? 0,
      ].join("|");
      continue;
    }
    if (tab.kind === "sql") {
      const state = params.sqlTabStates[tab.id];
      keys[tab.id] = [
        tab.id,
        tab.label,
        tab.sqlFileId ?? "",
        state?.connId ?? "",
        state?.database ?? "",
        state?.running ? "1" : "0",
        state?.error ? "1" : "0",
        sqlTabSessionsFingerprint(state),
        state?.activeResultSessionId ?? "",
      ].join("|");
      continue;
    }
    if (tab.kind === "database") {
      keys[tab.id] = [connectionsFingerprint, tab.connId, tab.dbName].join(":");
      continue;
    }
    if (tab.kind === "connection") {
      keys[tab.id] = [connectionsFingerprint, tab.connId].join(":");
      continue;
    }
    if (tab.kind === "redis-query") {
      keys[tab.id] = [connectionsFingerprint, tab.connId, tab.dbName ?? ""].join(":");
      continue;
    }
    if (tab.kind === "designer") {
      keys[tab.id] = [
        connectionsFingerprint,
        tab.connId,
        tab.dbName,
        tab.tableName,
        params.tableDesignerStates[tab.id] ? "1" : "0",
      ].join(":");
      continue;
    }
  }
  return keys;
}

/** ModuleSegmentDock 外层使用稳定 key，避免 query/transfer 切换时重挂载侧栏布局。 */
export function buildDatabaseModulePanelContentKey(): string {
  return "database-module";
}
