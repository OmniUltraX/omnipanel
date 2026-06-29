import { useCallback, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace, type DockRailPreset } from "../dock";
import {
  getModuleLeftSidebarSize,
  MODULE_LEFT_SIDEBAR_MAX_PX,
  MODULE_LEFT_SIDEBAR_MIN_PX,
  usePanelLayoutStore,
} from "../../stores/panelLayoutStore";
import { ModuleLeftColumn } from "./ModuleLeftColumn";
import "./moduleWorkspaceLayout.css";

const LEFT_COLLAPSED_PX = 12;

export interface ModuleWorkspaceLayoutProps {
  /** @deprecated 侧栏宽度已全局共用，此字段保留兼容、不再参与持久化 */
  layoutKey?: string;
  className?: string;
  /** 左栏顶栏标题（与模式图标两端对齐） */
  leftColumnTitle?: ReactNode;
  leftIconRail?: ReactNode;
  leftSidebar?: ReactNode;
  leftPreset?: DockRailPreset;
  leftSizePx?: number;
  leftMinPx?: number;
  leftMaxPx?: number | string;
  leftPanelRef?: React.RefObject<PanelImperativeHandle | null>;
  leftHandleClassName?: string;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  /** 右侧主区（通常为 ModuleSegmentDock 或内容区） */
  children: ReactNode;
  /** 底部条（如文件传输进度） */
  footer?: ReactNode;
}

/**
 * 模块统一左右布局：左侧图标栏 + 资源侧栏，右侧功能区。
 * 对齐终端 TerminalSessionsWorkspaceView 结构。
 */
export function ModuleWorkspaceLayout({
  layoutKey: _layoutKey,
  className,
  leftColumnTitle,
  leftIconRail,
  leftSidebar,
  leftPreset = "default",
  leftSizePx: propLeftSizePx,
  leftMinPx = MODULE_LEFT_SIDEBAR_MIN_PX,
  leftMaxPx = MODULE_LEFT_SIDEBAR_MAX_PX,
  leftPanelRef: externalLeftPanelRef,
  leftHandleClassName,
  onSidebarCollapsedChange,
  children,
  footer,
}: ModuleWorkspaceLayoutProps) {
  const savedSize = usePanelLayoutStore((s) => getModuleLeftSidebarSize(s.leftSizes));
  const setModuleLeftSidebarSize = usePanelLayoutStore((s) => s.setModuleLeftSidebarSize);
  const leftSizePx = propLeftSizePx ?? savedSize;
  const pendingLeftSizeRef = useRef<number | null>(null);
  const internalLeftPanelRef = useRef<PanelImperativeHandle | null>(null);
  const leftPanelRef = externalLeftPanelRef ?? internalLeftPanelRef;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const updateSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      setSidebarCollapsed(collapsed);
      onSidebarCollapsedChange?.(collapsed);
    },
    [onSidebarCollapsedChange],
  );

  const handleLeftResize = useCallback((sizePx: number) => {
    pendingLeftSizeRef.current = sizePx;
    updateSidebarCollapsed(sizePx < LEFT_COLLAPSED_PX);
  }, [updateSidebarCollapsed]);

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current ?? leftPanelRef.current?.getSize().inPixels;
    pendingLeftSizeRef.current = null;
    if (size == null || size < MODULE_LEFT_SIDEBAR_MIN_PX) {
      updateSidebarCollapsed(size != null && size < LEFT_COLLAPSED_PX);
      return;
    }
    setModuleLeftSidebarSize(size);
    updateSidebarCollapsed(false);
  }, [setModuleLeftSidebarSize, updateSidebarCollapsed, leftPanelRef]);

  const hasSidebarHeader = Boolean(leftColumnTitle || leftIconRail);
  const hasLeft = Boolean(hasSidebarHeader || leftSidebar);

  const resolvedHandleClassName =
    leftHandleClassName ??
    (hasSidebarHeader
      ? sidebarCollapsed
        ? "module-workspace-sidebar-handle module-workspace-sidebar-handle--collapsed"
        : "module-workspace-sidebar-handle module-workspace-sidebar-handle--open"
      : undefined);

  const rootClass = [
    "module-workspace-layout",
    className,
    sidebarCollapsed ? "module-workspace-layout--sidebar-collapsed" : "module-workspace-layout--sidebar-open",
    hasSidebarHeader ? "module-workspace-layout--has-sidebar-header" : "",
    !hasLeft ? "module-workspace-layout--no-left" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const main = (
    <div className="module-workspace-layout__main">
      <div className="module-workspace-layout__body">{children}</div>
      {footer ? <div className="module-workspace-layout__footer">{footer}</div> : null}
    </div>
  );

  if (!hasLeft) {
    return <div className={rootClass}>{main}</div>;
  }

  return (
    <DockWorkspace
      className={rootClass}
      leftPreset={leftPreset}
      leftSizePx={leftSizePx}
      leftMinPx={leftMinPx}
      leftMaxPx={leftMaxPx}
      leftPanelRef={leftPanelRef}
      leftHandleClassName={resolvedHandleClassName}
      onLeftResize={handleLeftResize}
      onLeftLayoutChanged={handleLeftLayoutChanged}
      left={
        <ModuleLeftColumn
          title={leftColumnTitle}
          iconRail={leftIconRail}
          sidebar={leftSidebar}
        />
      }
      main={main}
    />
  );
}
