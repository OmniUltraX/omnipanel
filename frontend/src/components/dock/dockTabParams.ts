import type { DockviewApi } from "dockview-react";
import type { DockableTab } from "./dockableTab";
import { logDockTabFile } from "./dockTabFileDebug";

export function tabMetaRev(tab: DockableTab): string {
  return `${tab.type ?? ""}|${tab.dirty ? 1 : 0}|${tab.saved ? 1 : 0}`;
}

export function tabParamsFromDockableTab(tab: DockableTab) {
  return {
    tabId: tab.id,
    label: tab.label,
    icon: tab.icon,
    tooltip: tab.tooltip ?? tab.label,
    status: tab.status,
    type: tab.type,
    dirty: tab.dirty,
    saved: tab.saved,
    tabMetaRev: tabMetaRev(tab),
  };
}

export function syncPanelTabParams(api: DockviewApi, tab: DockableTab): void {
  const panel = api.getPanel(tab.id);
  if (!panel) {
    if (tab.type === "file") {
      logDockTabFile("syncPanelTabParams", {
        tabId: tab.id,
        panelFound: false,
        params: tabParamsFromDockableTab(tab),
      });
    }
    return;
  }

  const params = tabParamsFromDockableTab(tab);
  const current = panel.api.getParameters() as Partial<typeof params> | undefined;
  const fileMetaChanged =
    tab.type === "file" &&
    (current?.type !== params.type ||
      current?.dirty !== params.dirty ||
      current?.saved !== params.saved ||
      current?.tabMetaRev !== params.tabMetaRev);
  const willUpdate =
    current?.label !== params.label ||
    current?.icon !== params.icon ||
    current?.tooltip !== params.tooltip ||
    current?.status !== params.status ||
    fileMetaChanged ||
    (tab.type !== "file" &&
      (current?.type !== params.type ||
        current?.dirty !== params.dirty ||
        current?.saved !== params.saved));
  if (tab.type === "file") {
    logDockTabFile("syncPanelTabParams", {
      tabId: tab.id,
      panelFound: true,
      params,
      current: current ?? null,
      fileMetaChanged,
      willUpdate,
    });
  }
  if (willUpdate) {
    panel.api.updateParameters(params);
  }
  if (panel.api.title !== tab.label) {
    panel.api.setTitle(tab.label);
  }
}
