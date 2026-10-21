import { useRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace } from "../../dock";
import {
  MODULE_LEFT_SIDEBAR_MAX_SIZE,
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
  /** 本表面自己的侧栏宽度 key。设置窗口与各功能模块分开记。 */
  layoutKey?: string;
  className?: string;
}

/**
 * 模块工作区布局：左侧可调整/可折叠边栏 + 主内容。
 * 基于 DockWorkspace，供设置窗口等复用。
 *
 * 左侧面板宽度按 layoutKey 分别持久化，折叠状态也按同一 key 分开。
 */
export function SidebarWorkspace({
  sidebar,
  children,
  sidebarSizePx: propSidebarSizePx,
  sidebarMinPx = MODULE_LEFT_SIDEBAR_MIN_PX,
  sidebarMaxPx = MODULE_LEFT_SIDEBAR_MAX_SIZE,
  layoutKey = "settings",
  className,
}: SidebarWorkspaceProps) {
  const leftPanelRef = useRef<PanelImperativeHandle | null>(null);

  const {
    leftDefaultSizePx,
    moduleLeftSidebarCollapsed,
    handleLeftResize,
    handleLeftLayoutChanged,
    handleLeftHandlePointerDown,
    handleLeftHandleKeyDown,
  } = useSharedModuleLeftSidebar({
    leftPanelRef,
    propSizePx: propSidebarSizePx,
    layoutKey,
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
      leftSizePx={leftDefaultSizePx}
      leftMinPx={sidebarMinPx}
      leftMaxPx={sidebarMaxPx}
      leftPanelRef={leftPanelRef}
      onLeftResize={handleLeftResize}
      onLeftLayoutChanged={handleLeftLayoutChanged}
      onLeftHandlePointerDown={handleLeftHandlePointerDown}
      onLeftHandleKeyDown={handleLeftHandleKeyDown}
      className={rootClass}
    />
  );
}
