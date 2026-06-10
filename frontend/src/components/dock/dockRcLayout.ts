import type { BoxBase, LayoutBase, PanelBase } from "rc-dock";

export function collectTabIds(layout: LayoutBase): Set<string> {
  const ids = new Set<string>();

  function walkPanel(panel: PanelBase) {
    for (const tab of panel.tabs) {
      if (tab.id) ids.add(tab.id);
    }
  }

  function walkBox(box: BoxBase | undefined) {
    if (!box) return;
    for (const child of box.children) {
      if ("tabs" in child) {
        walkPanel(child);
      } else {
        walkBox(child);
      }
    }
  }

  walkBox(layout.dockbox);
  walkBox(layout.floatbox);
  walkBox(layout.windowbox);
  walkBox(layout.maxbox);
  return ids;
}

export function createDefaultRcLayout(tabIds: string[], activeTabId: string): LayoutBase {
  if (tabIds.length === 0) {
    return {
      dockbox: {
        mode: "horizontal",
        children: [{ tabs: [] }],
      },
    };
  }

  return {
    dockbox: {
      mode: "horizontal",
      children: [
        {
          tabs: tabIds.map((id) => ({ id })),
          activeId: tabIds.includes(activeTabId) ? activeTabId : tabIds[0],
        },
      ],
    },
  };
}

function cloneLayout(layout: LayoutBase): LayoutBase {
  return JSON.parse(JSON.stringify(layout)) as LayoutBase;
}

function cleanBox(box: BoxBase, allowed: Set<string>): BoxBase {
  const children = box.children
    .map((child) => {
      if ("tabs" in child) {
        const tabs = child.tabs.filter((tab) => tab.id && allowed.has(tab.id));
        const activeId =
          child.activeId && allowed.has(child.activeId) ? child.activeId : tabs[0]?.id;
        return { ...child, tabs, activeId };
      }
      return cleanBox(child, allowed);
    })
    .filter((child) => {
      if ("tabs" in child) return child.tabs.length > 0;
      return child.children.length > 0;
    });

  return { ...box, children };
}

function addTabsToFirstPanel(
  layout: LayoutBase,
  tabIds: string[],
  activeTabId: string,
): LayoutBase {
  if (tabIds.length === 0) return layout;

  let added = false;

  function visitBox(box: BoxBase): BoxBase {
    const children = box.children.map((child) => {
      if ("tabs" in child) {
        if (added) return child;
        added = true;
        const existingIds = new Set(child.tabs.map((tab) => tab.id).filter(Boolean));
        const newTabs = tabIds
          .filter((id) => !existingIds.has(id))
          .map((id) => ({ id }));
        const tabs = [...child.tabs, ...newTabs];
        const activeId =
          activeTabId && tabIds.includes(activeTabId)
            ? activeTabId
            : child.activeId ?? tabs[0]?.id;
        return { ...child, tabs, activeId };
      }
      return visitBox(child);
    });
    return { ...box, children };
  }

  if (!added) {
    const allIds = [...collectTabIds(layout), ...tabIds];
    return createDefaultRcLayout([...new Set(allIds)], activeTabId);
  }

  return {
    ...layout,
    dockbox: visitBox(layout.dockbox),
  };
}

function layoutNeedsMerge(base: LayoutBase, tabIds: string[]): boolean {
  const allowed = new Set(tabIds);
  const existing = collectTabIds(base);
  if (existing.size !== allowed.size) return true;
  for (const id of tabIds) {
    if (!existing.has(id)) return true;
  }
  return false;
}

/** 将外部 tab 列表与已保存的 rc-dock 布局合并（增删 tab、修正 activeId） */
export function mergeTabsIntoRcLayout(
  base: LayoutBase | null,
  tabIds: string[],
  activeTabId: string,
): LayoutBase | null {
  if (tabIds.length === 0) {
    return null;
  }

  if (!base) {
    return createDefaultRcLayout(tabIds, activeTabId);
  }

  if (!layoutNeedsMerge(base, tabIds)) {
    return base;
  }

  const allowed = new Set(tabIds);
  const layout = cloneLayout(base);

  layout.dockbox = cleanBox(layout.dockbox, allowed);
  if (layout.floatbox) layout.floatbox = cleanBox(layout.floatbox, allowed);
  if (layout.windowbox) layout.windowbox = cleanBox(layout.windowbox, allowed);
  if (layout.maxbox) layout.maxbox = cleanBox(layout.maxbox, allowed);

  const missing = tabIds.filter((id) => !collectTabIds(layout).has(id));
  if (missing.length > 0) {
    return addTabsToFirstPanel(layout, missing, activeTabId);
  }

  return layout;
}

export function removeTabFromRcLayout(layout: LayoutBase, tabId: string): LayoutBase {
  const allowed = new Set(collectTabIds(layout));
  allowed.delete(tabId);
  if (allowed.size === 0) {
    return createDefaultRcLayout([], tabId);
  }
  const fallbackActive = [...allowed][0] ?? tabId;
  return mergeTabsIntoRcLayout(layout, [...allowed], fallbackActive) ?? createDefaultRcLayout([...allowed], fallbackActive);
}

export function diffRemovedTabIds(prev: LayoutBase, next: LayoutBase): string[] {
  const prevIds = collectTabIds(prev);
  const nextIds = collectTabIds(next);
  return [...prevIds].filter((id) => !nextIds.has(id));
}
