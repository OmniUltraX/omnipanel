import { useRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace } from "../../dock";
import {
  MODULE_LEFT_SIDEBAR_MAX_PX,
  MODULE_LEFT_SIDEBAR_MIN_PX,
} from "../../../stores/panelLayoutStore";
import { useSharedModuleLeftSidebar } from "../../../hooks/useSharedModuleLeftSidebar";

export interface SidebarWorkspaceProps {
  /** 左侧边栏（可拖拽调整宽度，拖至最窄可折叠隐藏） */
  sidebar: ReactNode;
  /** 主内容区 */
  children: ReactNode;
  /** 覆盖默认宽度（px） */
  sidebarSizePx?: number;
  /** 侧栏最小宽度（px 或百分比字符串） */
  sidebarMinPx?: number;
  /** 侧栏最大宽度（px 或百分比字符串） */
  sidebarMaxPx?: number | string;
  className?: string;
}

/**
 * 模块工作区布局：左侧可调整/可折叠边栏 + 主内容。
 * 基于 DockWorkspace，供设置窗口等复用。
 *
 * 左侧面板宽度与折叠状态在所有模块间共用并持久化。
 */
export function SidebarWorkspace({
  sidebar,
  children,
  sidebarSizePx: propSidebarSizePx,
  sidebarMinPx = MODULE_LEFT_SIDEBAR_MIN_PX,
  sidebarMaxPx = MODULE_LEFT_SIDEBAR_MAX_PX,
  className,
}: SidebarWorkspaceProps) {
  const leftPanelRef = useRef<PanelImperativeHandle | null>(null);

  const {
    leftSizePx,
    moduleLeftSidebarCollapsed,
    handleLeftResize,
    handleLeftLayoutChanged,
  } = useSharedModuleLeftSidebar({
    leftPanelRef,
    propSizePx: propSidebarSizePx,
  });

  const rootClass = [
    className,
    moduleLeftSidebarCollapsed ? "sidebar-workspace--collapsed" : "sidebar-workspace--open",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <DockWorkspace
      left={sidebar}
      main={children}
      leftSizePx={leftSizePx}
      leftMinPx={sidebarMinPx}
      leftMaxPx={sidebarMaxPx as number | undefined}
      leftPanelRef={leftPanelRef}
      onLeftResize={handleLeftResize}
      onLeftLayoutChanged={handleLeftLayoutChanged}
      className={rootClass}
    />
  );
}
