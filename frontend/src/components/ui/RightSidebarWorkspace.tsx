import { useCallback, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { DockWorkspace, type DockRailPreset } from "../dock";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";

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

function useRightPersistKey(): string {
  const pn = useLocation().pathname;
  return useMemo(
    () => `right:${pn.split("/").filter(Boolean)[0] || "default"}`,
    [pn],
  );
}

/**
 * 模块工作区布局：主内容 + 右侧可调整/可折叠边栏。
 * 基于 DockWorkspace，适用于右侧停靠面板（如 AI 助手 dockview）。
 *
 * 右侧面板的展开/折叠状态将自动按当前路由持久化。
 */
export function RightSidebarWorkspace({
  sidebar,
  children,
  preset = "default",
  sidebarSizePx: propSidebarSizePx,
  sidebarMinPx,
  sidebarMaxPx,
  className,
}: RightSidebarWorkspaceProps) {
  const persistKey = useRightPersistKey();
  const savedSize = usePanelLayoutStore((s) => s.rightSizes[persistKey]);
  const setRightSize = usePanelLayoutStore((s) => s.setRightSize);

  const sidebarSizePx = propSidebarSizePx ?? savedSize;

  const handleRightResize = useCallback(
    (sizePx: number) => {
      setRightSize(persistKey, sizePx);
    },
    [persistKey, setRightSize],
  );

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
      onRightResize={handleRightResize}
      className={className}
    />
  );
}
