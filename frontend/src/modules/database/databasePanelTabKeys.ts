import type { DbWorkspaceTab } from "./workspaceTabs";
import type { SqlTabState, TablePreviewState } from "./dbWorkspaceState";
import type { DbConnectionConfig } from "./api";

function connectionConfigFingerprint(configs: { id: string }[]): string {
  if (configs.length === 0) {
    return "";
  }
  return configs.map((c) => c.id).join(",");
}

/** 表预览 Tab 的 content key：仅身份字段，分页/脏行/loading 由 props 更新，不 remount grid。 */
function buildTablePreviewPanelContentKey(
  tabId: string,
  preview: TablePreviewState,
): string {
  return [
    preview.connId ?? "",
    preview.dbName ?? "",
    preview.tableName ?? "",
    tabId,
  ].join("|");
}

/** 非表预览 SQL Tab 的 volatile 指纹，用于 panel content key 增量失效。 */
export function buildSqlTabPanelKeySeed(
  workspaceTabs: DbWorkspaceTab[],
  state: {
    sqlTabStates: Record<string, SqlTabState>;
    tablePreviews: Record<string, TablePreviewState>;
    tabModes: Record<string, "data" | "sql">;
  },
): string {
  const parts: string[] = [];
  for (const tab of workspaceTabs) {
    if (tab.kind !== "sql") continue;
    if (state.tablePreviews[tab.id]?.tableName) continue;
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
        s?.result ? `${s.result.columns.length}:${s.result.rows.length}` : "0",
        state.tabModes[tab.id] ?? "sql",
      ].join("|"),
    );
  }
  return parts.join(";");
}

export function selectTablePreviewTabIdKey(state: {
  tablePreviews: Record<string, TablePreviewState>;
}): string {
  const ids: string[] = [];
  for (const [tabId, preview] of Object.entries(state.tablePreviews)) {
    if (preview.tableName) ids.push(tabId);
  }
  return ids.sort().join(",");
}

export function buildDatabasePanelContentKeysByTab(params: {
  workspaceTabs: DbWorkspaceTab[];
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableDesignerStates: Record<string, unknown>;
  tabModes: Record<string, "data" | "sql">;
  connections: DbConnectionConfig[];
}): Record<string, string> {
  const connectionsFingerprint = connectionConfigFingerprint(params.connections);
  const keys: Record<string, string> = {};
  for (const tab of params.workspaceTabs) {
    const preview = params.tablePreviews[tab.id];
    if (tab.kind === "sql" && preview?.tableName) {
      keys[tab.id] = buildTablePreviewPanelContentKey(tab.id, preview);
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
        state?.result ? `${state.result.columns.length}:${state.result.rows.length}` : "0",
        params.tabModes[tab.id] ?? "sql",
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

/** ModuleSegmentDock 外层仅需模块级 key（工作区 Tab 由内部 Dock 自行 invalidate）。 */
export function buildDatabaseModulePanelContentKey(params: { moduleTab: string }): string {
  return params.moduleTab;
}
