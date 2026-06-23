import type { DbWorkspaceTab } from "./workspaceTabs";
import type { SqlTabState, TablePreviewState } from "./dbWorkspaceState";
import type { DbConnectionConfig } from "./api";

function connectionConfigFingerprint(configs: { id: string }[]): string {
  if (configs.length === 0) {
    return "";
  }
  return configs.map((c) => c.id).join(",");
}

/** 按 Tab 计算 Dock panel 局部 invalidate key，避免全局 bump。 */
function buildTablePreviewPanelContentKey(
  tabId: string,
  preview: TablePreviewState,
  tabMode: "data" | "sql" | undefined,
): string {
  return [
    preview.connId,
    preview.dbName,
    preview.tableName,
    preview.page,
    preview.pageSize,
    preview.loading ? "1" : "0",
    preview.error ?? "",
    preview.data ? `${preview.data.rows.length}:${preview.totalRows}` : "0",
    tabMode ?? "data",
    tabId,
  ].join("|");
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
      keys[tab.id] = buildTablePreviewPanelContentKey(
        tab.id,
        preview,
        params.tabModes[tab.id],
      );
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
