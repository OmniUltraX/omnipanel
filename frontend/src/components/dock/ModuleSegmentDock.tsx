import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SerializedDockview } from "dockview-core";
import {
  DockableWorkspace,
  type DockAddTabConfig,
  type DockableTab,
} from "./DockableWorkspace";
import type { DockPanelRefreshProps } from "./dockPanelRefresh";
import type { DockTabPageType } from "./dockableTab";
import type { DockHeaderIconKind } from "./DockHeaderIcon";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { ModuleDockTitle } from "./ModuleDockTitle";
import {
  createInitialDockTabVisited,
  markDockTabVisited,
  shouldMountDockTabContent,
} from "./dockTabVisit";

export interface ModuleSegmentTab {
  id: string;
  label: string;
  icon?: DockHeaderIconKind;
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
  /** panel 被拖离本 dock 时回调 */
  onPanelTransferredOut?: (panelId: string, targetScope: string) => void;
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
  /**
   * 模块工作区默认 onlyWhenVisible，避免开 Tab 时非激活 panel 全量常驻 reconcile。
   * stickyVisit 开启时强制 always（宿主常驻），未访问 Tab 仍 render null。
   */
  defaultRenderer?: "always" | "onlyWhenVisible";
  /**
   * 是否延后通知 activeTabId（默认 true）。
   * 数据库侧栏联动需即时跟随时传 false。
   */
  deferActiveTabNotify?: boolean;
  /**
   * 模块非 live / 首页预热：挂起全部业务内容（chrome/layout 可保留）。
   */
  contentSuspended?: boolean;
  /**
   * 懒创建 + 访问后粘住：未访问 Tab 不挂内容；激活过的保持挂载防闪。
   * 开启后 defaultRenderer 使用 always（仅宿主），内容仍受 visited / contentSuspended 约束。
   */
  stickyVisit?: boolean;
}

const EMPTY_LAYOUT = null;

/**
 * 模块顶级 Dock：分段 Tab 或 session Tab 均通过此组件挂载，
 * 与终端模块共用 tabStyle / windowControl / 布局 chrome 行为。
 */
export const ModuleSegmentDock = memo(function ModuleSegmentDock({
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
  onPanelTransferredOut,
  moduleTitle,
  preActions,
  variant = "function",
  showTabBar = true,
  panelContentKey,
  panelContentKeysByTab,
  softRefreshKey,
  defaultRenderer = "onlyWhenVisible",
  deferActiveTabNotify,
  contentSuspended = false,
  stickyVisit = false,
}: ModuleSegmentDockProps) {
  const layoutRef = useRef(EMPTY_LAYOUT);
  const noopClose = useCallback(() => {}, []);
  const noopLayoutChange = useCallback(() => {}, []);

  const [visitedTabIds, setVisitedTabIds] = useState(() =>
    createInitialDockTabVisited(activeTabId),
  );

  useEffect(() => {
    if (contentSuspended || !stickyVisit) return;
    setVisitedTabIds((prev) => markDockTabVisited(prev, activeTabId));
  }, [activeTabId, contentSuspended, stickyVisit]);

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

  const wrappedRenderPanel = useCallback(
    (tabId: string) => {
      if (stickyVisit || contentSuspended) {
        const mount = shouldMountDockTabContent({
          active: tabId === activeTabId,
          visited: visitedTabIds.has(tabId),
          contentSuspended,
        });
        if (!mount) return null;
      }
      return renderPanel(tabId);
    },
    [
      activeTabId,
      contentSuspended,
      renderPanel,
      stickyVisit,
      visitedTabIds,
    ],
  );

  const resolvedRenderer =
    stickyVisit || contentSuspended ? "always" : defaultRenderer;

  const rootClassName = [
    "module-root-dock",
    "module-segment-dock",
    `module-segment-dock--variant-${variant}`,
    !showTabBar && "module-segment-dock--no-tab-bar",
    className,
    !enabled && "module-segment-dock--route-inactive",
    contentSuspended && "module-segment-dock--content-suspended",
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
      renderPanel={wrappedRenderPanel}
      addTabConfig={enabled ? addTabConfig : undefined}
      onTabContextMenu={onTabContextMenu}
      onTabDoubleClick={onTabDoubleClick}
      emptyContent={emptyContent}
      preActions={composedPreActions}
      acceptExternalDrops={acceptExternalDrops}
      onPanelTransferredOut={onPanelTransferredOut}
      windowChromeVariant="segment"
      panelContentKey={panelContentKey}
      panelContentKeysByTab={panelContentKeysByTab}
      softRefreshKey={softRefreshKey}
      defaultRenderer={resolvedRenderer}
      deferActiveTabNotify={deferActiveTabNotify}
    />
  );
});
