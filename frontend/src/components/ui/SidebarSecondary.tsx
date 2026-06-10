import type { ReactNode } from "react";
import { DockWorkspace, type DockRailPreset } from "../dock";

/** 右侧边栏宽度预设 */
export type SidebarSecondaryPreset = DockRailPreset;

export interface SidebarSecondaryProps {
  /** 主内容区 */
  children: ReactNode;
  /** 右侧边栏 */
  sidebar: ReactNode;
  /** 侧栏宽度预设 */
  preset?: SidebarSecondaryPreset;
  /** 覆盖预设的默认宽度（px） */
  sidebarSizePx?: number;
  /** 侧栏最小宽度（px） */
  sidebarMinPx?: number;
  /** 侧栏最大宽度（px 或百分比字符串） */
  sidebarMaxPx?: number | string;
  className?: string;
}

/**
 * 右侧可调整/可折叠边栏布局。
 * 与 SidebarWorkspace 对称，侧栏位于右侧，收起方向向右。
 */
export function SidebarSecondary({
  children,
  sidebar,
  preset = "default",
  sidebarSizePx,
  sidebarMinPx,
  sidebarMaxPx,
  className,
}: SidebarSecondaryProps) {
  return (
    <DockWorkspace
      main={children}
      right={sidebar}
      rightPreset={preset}
      rightSizePx={sidebarSizePx}
      rightMinPx={sidebarMinPx}
      rightMaxPx={sidebarMaxPx}
      className={className}
    />
  );
}
