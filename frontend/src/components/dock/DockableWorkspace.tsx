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
  onSavedLayoutChange: (layout: LayoutBase) => void;
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

  const tabIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    tabs.forEach((tab, index) => map.set(tab.id, index));
    return map;
  }, [tabs]);

  const loadTab = useCallback((saved: TabBase): TabData => {
    const meta = tabsRef.current.find((tab) => tab.id === saved.id);
    const id = saved.id ?? "";
    const index = tabIndexMap.get(id) ?? 0;
    const label = meta?.label ?? id;
    const closable = meta?.closable !== false;

    const titleLabel = onTabContextMenu ? (
      <span
        className="dockable-tab-title"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTabContextMenu(event, id, index);
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
  }, [onTabContextMenu, tabIndexMap]);

  const saveTab = useCallback((tab: TabData): TabBase => ({ id: tab.id }), []);

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const tabsLabelSignature = useMemo(
    () => tabs.map((tab) => `${tab.id}:${tab.label}`).join("|"),
    [tabs],
  );

  const layout = useMemo(
    () => mergeTabsIntoRcLayout(savedLayout, tabIds, activeTabId),
    [savedLayout, tabIds, activeTabId],
  );

  // 仅标题变更时 layout 引用不变，克隆一份以触发 rc-dock reload（不可用 updateTab，会触发 changeLayout 死循环）
  const layoutForRcDock = useMemo(
    () => JSON.parse(JSON.stringify(layout)) as LayoutBase,
    [layout, tabsLabelSignature],
  );

  // 新增/关闭 tab 时合并布局并持久化；受控模式下须保持 layout 引用稳定，避免每次 render 触发 reload
  useEffect(() => {
    if (layout !== savedLayout) {
      onSavedLayoutChange(layout);
    }
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
