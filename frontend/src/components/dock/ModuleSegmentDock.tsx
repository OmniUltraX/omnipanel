import { useCallback, useMemo, useRef, type ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import {
  DockableWorkspace,
  type DockAddTabConfig,
  type DockableTab,
} from "./DockableWorkspace";
import type { DockTabIconKind } from "./DockTabIcon";
import type { TopbarTabDef } from "../../stores/topbarStore";

export interface ModuleSegmentTab {
  id: string;
  label: string;
  icon?: DockTabIconKind;
  tooltip?: string;
  closable?: boolean;
  status?: TopbarTabDef["status"];
  panelType?: string;
}

export interface ModuleSegmentDockProps {
  tabs: ModuleSegmentTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  renderPanel: (tabId: string) => ReactNode;
  className?: string;
  /** 为 false 时不显示 tab 栏，仅渲染当前 activeTabId 对应面板（非激活路由时使用） */
  enabled?: boolean;
  /** 是否在 tab 栏嵌入窗口控制按钮；默认 true */
  windowControl?: boolean;
  /** 可关闭 tab（终端 session 等）；默认 noop */
  onCloseTab?: (tabId: string) => void;
  /** 布局持久化；默认不持久化 */
  savedLayout?: SerializedDockview | null;
  onSavedLayoutChange?: (layout: SerializedDockview | null) => void;
  addTabConfig?: DockAddTabConfig;
  onTabContextMenu?: (
    event: React.MouseEvent,
    tabId: string,
    index: number,
  ) => void;
  emptyContent?: ReactNode;
  dockScope?: string;
}

const EMPTY_LAYOUT = null;

/**
 * 模块顶级 Dock：分段 Tab 或 session Tab 均通过此组件挂载，
 * 与终端模块共用 tabStyle / windowControl / 布局 chrome 行为。
 */
export function ModuleSegmentDock({
  tabs,
  activeTabId,
  onActiveTabChange,
  renderPanel,
  className,
  enabled = true,
  windowControl = true,
  onCloseTab,
  savedLayout,
  onSavedLayoutChange,
  addTabConfig,
  onTabContextMenu,
  emptyContent,
  dockScope,
}: ModuleSegmentDockProps) {
  const layoutRef = useRef(EMPTY_LAYOUT);
  const noopClose = useCallback(() => {}, []);
  const noopLayoutChange = useCallback(() => {}, []);

  const dockTabs = useMemo(
    (): DockableTab[] =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        panelType: tab.panelType ?? "module-segment",
        closable: tab.closable ?? false,
        icon: tab.icon,
        tooltip: tab.tooltip ?? tab.label,
        status: tab.status,
      })),
    [tabs],
  );

  const rootClassName = className
    ? `module-root-dock module-segment-dock ${className}`
    : "module-root-dock module-segment-dock";

  if (!enabled) {
    return <>{renderPanel(activeTabId)}</>;
  }

  return (
    <DockableWorkspace
      className={rootClassName}
      dockScope={dockScope}
      tabStyle="topbar"
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={onActiveTabChange}
      onCloseTab={onCloseTab ?? noopClose}
      savedLayout={savedLayout ?? layoutRef.current}
      onSavedLayoutChange={onSavedLayoutChange ?? noopLayoutChange}
      enableTabGroups={false}
      windowControl={windowControl}
      renderPanel={renderPanel}
      addTabConfig={addTabConfig}
      onTabContextMenu={onTabContextMenu}
      emptyContent={emptyContent}
    />
  );
}
