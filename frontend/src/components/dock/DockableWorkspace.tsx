import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import RcDockLayout, {
  type LayoutBase,
  type TabBase,
  type TabData,
} from "rc-dock";
import "rc-dock/dist/rc-dock-dark.css";
import {
  createDefaultRcLayout,
  diffRemovedTabIds,
  mergeTabsIntoRcLayout,
} from "./dockRcLayout";

export interface DockableTab {
  id: string;
  label: string;
  closable?: boolean;
}

export interface DockableWorkspaceProps {
  tabs: DockableTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  savedLayout: LayoutBase | null;
  onSavedLayoutChange: (layout: LayoutBase | null) => void;
  renderPanel: (tabId: string) => ReactNode;
  className?: string;
  emptyContent?: ReactNode;
  onTabContextMenu?: (event: React.MouseEvent, tabId: string, index: number) => void;
}

export function DockableWorkspace({
  tabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  savedLayout,
  onSavedLayoutChange,
  renderPanel,
  className,
  emptyContent,
  onTabContextMenu,
}: DockableWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const renderPanelRef = useRef(renderPanel);
  renderPanelRef.current = renderPanel;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const tabIdsSignature = useMemo(
    () => tabs.map((tab) => tab.id).join("|"),
    [tabs],
  );

  const tabIds = useMemo(() => {
    if (!tabIdsSignature) return [];
    return tabIdsSignature.split("|");
  }, [tabIdsSignature]);

  const tabsLabelSignature = useMemo(
    () => tabs.map((tab) => `${tab.id}:${tab.label}`).join("|"),
    [tabs],
  );

  const loadTab = useCallback((saved: TabBase): TabData => {
    const tabsList = tabsRef.current;
    const meta = tabsList.find((tab) => tab.id === saved.id);
    const id = saved.id ?? "";
    const index = tabsList.findIndex((tab) => tab.id === id);
    const label = meta?.label ?? id;
    const closable = meta?.closable !== false;

    const titleLabel = onTabContextMenu ? (
      <span
        className="dockable-tab-title"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTabContextMenu(event, id, index >= 0 ? index : 0);
        }}
      >
        {label}
      </span>
    ) : (
      <span className="dockable-tab-title">{label}</span>
    );

    return {
      id,
      group: "dockable-main",
      title: titleLabel,
      content: <div className="dock-pane-surface">{renderPanelRef.current(id)}</div>,
      closable,
      cached: true,
    };
  }, [onTabContextMenu]);

  const saveTab = useCallback((tab: TabData): TabBase => ({ id: tab.id }), []);

  const layout = useMemo(
    () => mergeTabsIntoRcLayout(savedLayout, tabIds, activeTabId),
    [savedLayout, tabIdsSignature, activeTabId, tabIds],
  );

  const layoutForRcDock = useMemo(() => {
    const base = layout ?? createDefaultRcLayout(tabIds, activeTabId);
    return JSON.parse(JSON.stringify(base)) as LayoutBase;
  }, [layout, tabsLabelSignature, tabIdsSignature, activeTabId, tabIds]);

  // 新增/关闭 tab 时合并布局并持久化；无 tab 时 layout 为 null，须与 savedLayout 同步一次后停止
  useEffect(() => {
    if (layout === savedLayout) return;
    onSavedLayoutChange(layout);
  }, [layout, savedLayout, onSavedLayoutChange]);

  // rc-dock 关闭按钮需 drag-ignore，避免点击 × 时误触发 Tab 拖拽
  useEffect(() => {
    const root = workspaceRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".dock-tab-btn .dock-tab-close-btn").forEach((el) => {
      el.classList.add("drag-ignore");
    });
  }, [tabs.length, tabsLabelSignature]);

  const handleLayoutChange = useCallback(
    (nextLayout: LayoutBase, currentTabId?: string) => {
      const prevTabIds = tabsRef.current.map((tab) => tab.id);
      const prevLayout = mergeTabsIntoRcLayout(
        savedLayout ?? createDefaultRcLayout(prevTabIds, activeTabId),
        prevTabIds,
        activeTabId,
      );
      const removed = diffRemovedTabIds(prevLayout, nextLayout);

      onSavedLayoutChange(nextLayout);

      if (currentTabId) {
        onActiveTabChange(currentTabId);
      }

      for (const tabId of removed) {
        if (tabsRef.current.some((tab) => tab.id === tabId)) {
          onCloseTab(tabId);
        }
      }
    },
    [savedLayout, activeTabId, onSavedLayoutChange, onActiveTabChange, onCloseTab],
  );

  if (tabs.length === 0) {
    return (
      <div className={`dockable-workspace rc-dock-wrap${className ? ` ${className}` : ""}`}>
        <div className="dockable-workspace__empty">{emptyContent}</div>
      </div>
    );
  }

  return (
    <div
      ref={workspaceRef}
      className={`dockable-workspace rc-dock-wrap${className ? ` ${className}` : ""}`}
    >
      <RcDockLayout
        layout={layoutForRcDock}
        loadTab={loadTab}
        saveTab={saveTab}
        dropMode="default"
        onLayoutChange={handleLayoutChange}
        afterPanelLoaded={(_saved, loaded) => {
          for (const tab of loaded.tabs) {
            if (tab.closable !== false) {
              tab.closable = true;
            }
          }
        }}
        groups={{
          "dockable-main": {
            floatable: true,
            tabLocked: false,
          },
        }}
        style={{ position: "absolute", inset: 0 }}
      />
    </div>
  );
}

export type { LayoutBase as RcDockSavedLayout };
