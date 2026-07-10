import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace, type DockRailPreset } from "../dock";
import {
  getModuleLeftSidebarSize,
  MODULE_LEFT_SIDEBAR_DEFAULT_PX,
  MODULE_LEFT_SIDEBAR_MAX_PX,
  MODULE_LEFT_SIDEBAR_MIN_PX,
  usePanelLayoutStore,
} from "../../stores/panelLayoutStore";
import { useSharedModuleLeftSidebar } from "../../hooks/useSharedModuleLeftSidebar";
import { useModuleVisibility } from "../../lib/moduleVisibility";
import { ModuleLeftColumn } from "./ModuleLeftColumn";
import "./moduleWorkspaceLayout.css";

export interface ModuleWorkspaceLayoutProps {
  className?: string;
  /** 左栏顶栏标题（与模式图标两端对齐） */
  leftColumnTitle?: ReactNode;
  leftIconRail?: ReactNode;
  leftSidebar?: ReactNode;
  /** @deprecated 所有模块已统一侧栏尺寸，保留仅为兼容旧调用 */
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
  className,
  leftColumnTitle,
  leftIconRail,
  leftSidebar,
  leftSizePx: propLeftSizePx,
  leftMinPx = MODULE_LEFT_SIDEBAR_MIN_PX,
  leftMaxPx = MODULE_LEFT_SIDEBAR_MAX_PX,
  leftPanelRef: externalLeftPanelRef,
  leftHandleClassName,
  onSidebarCollapsedChange,
  children,
  footer,
}: ModuleWorkspaceLayoutProps) {
  const moduleSidebarToggleNonce = usePanelLayoutStore((s) => s.moduleSidebarToggleNonce);
  const { active: moduleActive } = useModuleVisibility();
  const internalLeftPanelRef = useRef<PanelImperativeHandle | null>(null);
  const leftPanelRef = externalLeftPanelRef ?? internalLeftPanelRef;
  const lastSidebarToggleNonceRef = useRef(moduleSidebarToggleNonce);

  const hasSidebarHeader = Boolean(leftColumnTitle || leftIconRail);
  const hasLeft = Boolean(hasSidebarHeader || leftSidebar);

  const {
    leftSizePx,
    moduleLeftSidebarCollapsed,
    handleLeftResize,
    handleLeftLayoutChanged,
    updateSidebarCollapsed,
  } = useSharedModuleLeftSidebar({
    leftPanelRef,
    syncWhenActive: true,
    moduleActive,
    hasLeft,
    propSizePx: propLeftSizePx,
    onCollapsedChange: onSidebarCollapsedChange,
  });

  const toggleSidebarFromShell = useCallback(() => {
    const handle = leftPanelRef.current;
    if (!handle) return;
    if (handle.isCollapsed()) {
      const restorePx =
        getModuleLeftSidebarSize(usePanelLayoutStore.getState().leftSizes) ??
        leftSizePx ??
        MODULE_LEFT_SIDEBAR_DEFAULT_PX;
      handle.expand();
      requestAnimationFrame(() => {
        handle.resize(`${restorePx}px`);
        updateSidebarCollapsed(false);
      });
      return;
    }
    handle.collapse();
    updateSidebarCollapsed(true);
  }, [leftPanelRef, leftSizePx, updateSidebarCollapsed]);

  useEffect(() => {
    if (!moduleActive || !hasLeft) return;
    if (moduleSidebarToggleNonce === lastSidebarToggleNonceRef.current) return;
    lastSidebarToggleNonceRef.current = moduleSidebarToggleNonce;
    toggleSidebarFromShell();
  }, [moduleSidebarToggleNonce, moduleActive, hasLeft, toggleSidebarFromShell]);

  const resolvedHandleClassName =
    leftHandleClassName ??
    (hasSidebarHeader
      ? moduleLeftSidebarCollapsed
        ? "module-workspace-sidebar-handle module-workspace-sidebar-handle--collapsed"
        : "module-workspace-sidebar-handle module-workspace-sidebar-handle--open"
      : undefined);

  const rootClass = [
    "module-workspace-layout",
    className,
    moduleLeftSidebarCollapsed
      ? "module-workspace-layout--sidebar-collapsed"
      : "module-workspace-layout--sidebar-open",
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
      leftSizePx={leftSizePx}
      leftMinPx={leftMinPx}
      leftMaxPx={leftMaxPx as number | undefined}
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

