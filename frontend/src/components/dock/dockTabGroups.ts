import type { DockviewApi } from "dockview-react";
import type { DockableTab } from "./DockableWorkspace";
import { getTabGroupMeta, PANEL_TYPE_PARAM } from "./dockPanelType";

function supportsTabGroups(
  api: DockviewApi,
): api is DockviewApi & {
  createTabGroup: DockviewApi["createTabGroup"];
  getTabGroups: DockviewApi["getTabGroups"];
  getTabGroupForPanel: DockviewApi["getTabGroupForPanel"];
  addPanelToTabGroup: DockviewApi["addPanelToTabGroup"];
  removePanelFromTabGroup: DockviewApi["removePanelFromTabGroup"];
  dissolveTabGroup: DockviewApi["dissolveTabGroup"];
} {
  return typeof api.createTabGroup === "function";
}

/**
 * 按 panelType 将同一 dockview group 内的面板归入 tab group；
 * 同类型 ≥2 个面板时显示可折叠 chip，仅 1 个时解散分组。
 */
export function syncTabGroupsByPanelType(
  api: DockviewApi,
  tabs: DockableTab[],
  resolveTabGroupMeta?: (panelType: string) => Partial<{ label: string; color: string }> | undefined,
): void {
  if (!supportsTabGroups(api)) return;

  const typeByPanelId = new Map(tabs.map((tab) => [tab.id, tab.panelType]));

  for (const group of api.groups) {
    const groupId = group.id;
    const managedPanelIds = group.panels
      .map((panel) => panel.id)
      .filter((panelId) => typeByPanelId.has(panelId));

    // 类型变更时先从旧 tab group 移除
    for (const panelId of managedPanelIds) {
      const expectedType = typeByPanelId.get(panelId)!;
      const current = api.getTabGroupForPanel({ groupId, panelId });
      if (!current) continue;
      if (current.componentParams?.[PANEL_TYPE_PARAM] !== expectedType) {
        api.removePanelFromTabGroup({ groupId, panelId });
      }
    }

    const panelsByType = new Map<string, string[]>();
    for (const panelId of managedPanelIds) {
      const panelType = typeByPanelId.get(panelId)!;
      const list = panelsByType.get(panelType) ?? [];
      list.push(panelId);
      panelsByType.set(panelType, list);
    }

    let tabGroups = api.getTabGroups({ groupId });

    for (const [panelType, panelIds] of panelsByType) {
      if (panelIds.length < 2) {
        for (const panelId of panelIds) {
          if (api.getTabGroupForPanel({ groupId, panelId })) {
            api.removePanelFromTabGroup({ groupId, panelId });
          }
        }
        const orphan = tabGroups.find(
          (tg) => tg.componentParams?.[PANEL_TYPE_PARAM] === panelType,
        );
        if (orphan) {
          api.dissolveTabGroup({ groupId, tabGroupId: orphan.id });
        }
        continue;
      }

      let tabGroup = tabGroups.find(
        (tg) => tg.componentParams?.[PANEL_TYPE_PARAM] === panelType,
      );

      if (!tabGroup) {
        const meta = getTabGroupMeta(panelType, resolveTabGroupMeta);
        tabGroup = api.createTabGroup({
          groupId,
          label: meta.label,
          color: meta.color,
          componentParams: { [PANEL_TYPE_PARAM]: panelType },
        });
        tabGroups = api.getTabGroups({ groupId });
      } else {
        const meta = getTabGroupMeta(panelType, resolveTabGroupMeta);
        if (tabGroup.label !== meta.label) tabGroup.setLabel(meta.label);
        if (tabGroup.color !== meta.color) tabGroup.setColor(meta.color);
      }

      for (const panelId of panelIds) {
        if (!tabGroup.containsPanel(panelId)) {
          api.addPanelToTabGroup({
            groupId,
            tabGroupId: tabGroup.id,
            panelId,
          });
        }
      }
    }

    for (const tg of api.getTabGroups({ groupId })) {
      const panelType = tg.componentParams?.[PANEL_TYPE_PARAM] as string | undefined;
      if (!panelType) continue;
      const count = (panelsByType.get(panelType) ?? []).length;
      if (count < 2) {
        api.dissolveTabGroup({ groupId, tabGroupId: tg.id });
      }
    }
  }
}

/** 解散所有 tab group，恢复每个 panel 独立 Tab（用于数据库等同类型多 Tab 场景）。 */
export function clearTabGroups(api: DockviewApi): void {
  if (!supportsTabGroups(api)) return;

  for (const group of api.groups) {
    const groupId = group.id;
    for (const panel of group.panels) {
      if (api.getTabGroupForPanel({ groupId, panelId: panel.id })) {
        api.removePanelFromTabGroup({ groupId, panelId: panel.id });
      }
    }
    for (const tabGroup of api.getTabGroups({ groupId })) {
      api.dissolveTabGroup({ groupId, tabGroupId: tabGroup.id });
    }
  }
}
