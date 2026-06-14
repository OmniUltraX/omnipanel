import type { ReactNode } from "react";
import { DockWorkspace, type DockRailPreset } from "../dock";

/** 侧栏宽度预设（像素级默认值见 DockWorkspace） */
export type RightSidebarWorkspacePreset = DockRailPreset;

export interface RightSidebarWorkspaceProps {
  /** 右侧边栏（可拖拽调整宽度，拖至最窄可折叠隐藏） */
  sidebar: ReactNode;
  /** 主内容区 */
  children: ReactNode;
  /** 侧栏宽度预设：default | schema | host | server | settings | ai */
  preset?: RightSidebarWorkspacePreset;
  /** 覆盖预设的默认宽度（px） */
  sidebarSizePx?: number;
  /** 侧栏最小宽度（px 或百分比字符串） */
  sidebarMinPx?: number;
  /** 侧栏最大宽度（px 或百分比字符串） */
  sidebarMaxPx?: number | string;
  className?: string;
}

/**
 * 模块工作区布局：主内容 + 右侧可调整/可折叠边栏。
 * 基于 DockWorkspace，适用于右侧停靠面板（如 AI 助手 dockview）。
 */
export function RightSidebarWorkspace({
  sidebar,
  children,
  preset = "default",
  sidebarSizePx,
  sidebarMinPx,
  sidebarMaxPx,
  className,
}: RightSidebarWorkspaceProps) {
  return (
    <DockWorkspace
      main={children}
      right={sidebar}
      rightPreset={preset}
      rightSizePx={sidebarSizePx}
      rightMinPx={sidebarMinPx}
      // 右侧边栏最大宽度默认限制为窗口宽度的 60%，避免在大窗口下被拉得过宽。
      // 调用方仍可通过 sidebarMaxPx 或 preset 显式覆盖。
      rightMaxPx={sidebarMaxPx ?? "60%"}
      className={className}
    />
  );
}
