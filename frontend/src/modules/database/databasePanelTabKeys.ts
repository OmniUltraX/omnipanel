import type { DbWorkspaceTab } from "./workspaceTabs";
import type { SqlTabState, TablePreviewState } from "./dbWorkspaceState";

/** 按 Tab 计算 Dock panel 局部 invalidate key，避免全局 bump。 */
export function buildDatabasePanelContentKeysByTab(params: {
  workspaceTabs: DbWorkspaceTab[];
  activeWorkspaceTabId: string;
  sqlTabStates: Record<string, SqlTabState>;
  tablePreviews: Record<string, TablePreviewState>;
  tableDesignerStates: Record<string, unknown>;
  tabModes: Record<string, "data" | "sql">;
}): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const tab of params.workspaceTabs) {
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
        tab.id === params.activeWorkspaceTabId ? "1" : "0",
      ].join("|");
      continue;
    }
    if (tab.kind === "database") {
      keys[tab.id] = `${tab.connId}:${tab.dbName}`;
      continue;
    }
    if (tab.kind === "connection") {
      keys[tab.id] = tab.connId;
      continue;
    }
    if (tab.kind === "designer") {
      keys[tab.id] = [
        tab.connId,
        tab.dbName,
        tab.tableName,
        params.tableDesignerStates[tab.id] ? "1" : "0",
      ].join(":");
      continue;
    }
    const preview = params.tablePreviews[tab.id];
    if (preview?.tableName) {
      keys[tab.id] = [
        preview.connId,
        preview.dbName,
        preview.tableName,
        preview.page,
        preview.pageSize,
        preview.loading ? "1" : "0",
        preview.error ?? "",
        preview.data ? `${preview.data.rows.length}:${preview.totalRows}` : "0",
        params.tabModes[tab.id] ?? "data",
      ].join("|");
    }
  }
  return keys;
}

/** ModuleSegmentDock 外层仅需模块级 key。 */
export function buildDatabaseModulePanelContentKey(params: {
  workspaceInitialized: boolean;
  moduleTab: string;
  workspaceTabCount: number;
}): string {
  return [
    params.workspaceInitialized ? "1" : "0",
    params.moduleTab,
    params.workspaceTabCount,
  ].join(";");
}
