import { useCallback, useMemo, useRef, type ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import {
  DockableWorkspace,
  type DockAddTabConfig,
  type DockableTab,
} from "./DockableWorkspace";
import type { DockPanelRefreshProps } from "./dockPanelRefresh";
import type { DockTabPageType } from "./dockableTab";
import type { DockTabIconKind } from "./DockTabIcon";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { ModuleDockTitle } from "./ModuleDockTitle";

export interface ModuleSegmentTab {
  id: string;
  label: string;
  icon?: DockTabIconKind;
  tooltip?: string;
  closable?: boolean;
  status?: TopbarTabDef["status"];
  panelType?: string;
  /** 保留 panel，仅隐藏 Tab 栏标签 */
  tabBarHidden?: boolean;
  type?: DockTabPageType;
  dirty?: boolean;
  saved?: boolean;
  /** Schema 预览 Tab：标题斜体 */
  preview?: boolean;
}

export interface ModuleSegmentDockProps extends DockPanelRefreshProps {
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
  onTabDoubleClick?: (tabId: string) => void;
  emptyContent?: ReactNode;
  dockScope?: string;
  /** 是否接受其他 dockview 拖入的 panel */
  acceptExternalDrops?: boolean;
  /** Tab 栏左侧模块标题（对齐设计稿 .topbar-title） */
  moduleTitle?: ReactNode;
  /** Tab 栏前缀区域（tabs 左侧，位于 moduleTitle 之后，如工作区切换） */
  preActions?: ReactNode;
  /** workspace = 工作区 Tab（SQL/文档/HTTP）；function = 功能分段 Tab */
  variant?: "workspace" | "function";
  /** 为 false 时隐藏 Tab 栏，仅保留标题行与窗口控制（待办全宽页等） */
  showTabBar?: boolean;
  panelContentKeysByTab?: Record<string, string>;
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
  onTabDoubleClick,
  emptyContent,
  dockScope,
  acceptExternalDrops,
  moduleTitle,
  preActions,
  variant = "function",
  showTabBar = true,
  panelContentKey,
  panelContentKeysByTab,
  softRefreshKey,
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
        tabBarHidden: tab.tabBarHidden,
        type: tab.type,
        dirty: tab.dirty,
        saved: tab.saved,
        preview: tab.preview,
      })),
    [tabs],
  );

  const rootClassName = [
    "module-root-dock",
    "module-segment-dock",
    `module-segment-dock--variant-${variant}`,
    !showTabBar && "module-segment-dock--no-tab-bar",
    className,
    !enabled && "module-segment-dock--route-inactive",
  ]
    .filter(Boolean)
    .join(" ");

  const composedPreActions = useMemo(() => {
    const hasTitle = moduleTitle != null && moduleTitle !== "";
    if (!hasTitle && !preActions) return undefined;
    return (
      <>
        {hasTitle ? <ModuleDockTitle>{moduleTitle}</ModuleDockTitle> : null}
        {preActions}
      </>
    );
  }, [moduleTitle, preActions]);

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
      addTabConfig={enabled ? addTabConfig : undefined}
      onTabContextMenu={onTabContextMenu}
      onTabDoubleClick={onTabDoubleClick}
      emptyContent={emptyContent}
      preActions={composedPreActions}
      acceptExternalDrops={acceptExternalDrops}
      panelContentKey={panelContentKey}
      panelContentKeysByTab={panelContentKeysByTab}
      softRefreshKey={softRefreshKey}
    />
  );
}
