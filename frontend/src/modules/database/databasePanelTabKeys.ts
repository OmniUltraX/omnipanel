import type { DbWorkspaceTab } from "./workspaceTabs";
import type { SqlTabState, TablePreviewState } from "./dbWorkspaceState";
import type { DbConnectionConfig } from "./api";

function connectionConfigFingerprint(configs: { id: string }[]): string {
  if (configs.length === 0) {
    return "";
  }
  return configs.map((c) => c.id).join(",");
}

function sqlTabStableFingerprint(state: SqlTabState | undefined): string {
  return [state?.connId ?? "", state?.database ?? ""].join(":");
}

/** 非表预览 SQL Tab 的稳定指纹，用于 schema 预载等；不含结果会话 volatile 状态。 */
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
    parts.push([tab.id, tab.sqlFileId ?? "", sqlTabStableFingerprint(s)].join("|"));
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
      // 结果会话由 DbPanelSurface 内 SqlResultSessionsDock 自行增量刷新；
      // 此处 key 仅含稳定元数据，避免每次执行/切换结果 Tab 时 remount 整个 SQL 面板。
      keys[tab.id] = [
        tab.id,
        tab.label,
        tab.sqlFileId ?? "",
        sqlTabStableFingerprint(state),
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
    if (tab.kind === "toolbox") {
      keys[tab.id] = [
        connectionsFingerprint,
        tab.toolboxTab,
        tab.label,
      ].join(":");
      continue;
    }
  }
  return keys;
}

/** ModuleSegmentDock 外层使用稳定 key，避免 query/dataSync/schemaSync 切换时重挂载侧栏布局。 */
export function buildDatabaseModulePanelContentKey(): string {
  return "database-module";
}
