import { useCallback, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { DockWorkspace, type DockRailPreset } from "../dock";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";

/** 侧栏宽度预设（像素级默认值见 DockWorkspace） */
export type SidebarWorkspacePreset = DockRailPreset;

export interface SidebarWorkspaceProps {
  /** 左侧边栏（可拖拽调整宽度，拖至最窄可折叠隐藏） */
  sidebar: ReactNode;
  /** 主内容区 */
  children: ReactNode;
  /** 侧栏宽度预设：default | schema | host | server */
  preset?: SidebarWorkspacePreset;
  /** 覆盖预设的默认宽度（px） */
  sidebarSizePx?: number;
  /** 侧栏最小宽度（px 或百分比字符串） */
  sidebarMinPx?: number;
  /** 侧栏最大宽度（px 或百分比字符串） */
  sidebarMaxPx?: number | string;
  className?: string;
}

function useSidebarPersistKey(): string {
  const pn = useLocation().pathname;
  return useMemo(() => pn.split("/").filter(Boolean)[0] || "default", [pn]);
}

/**
 * 模块工作区布局：左侧可调整/可折叠边栏 + 主内容。
 * 基于 DockWorkspace，供 SSH、服务器、数据库等模块复用。
 *
 * 左侧面板的展开/折叠状态将自动按当前路由持久化。
 */
export function SidebarWorkspace({
  sidebar,
  children,
  preset = "default",
  sidebarSizePx: propSidebarSizePx,
  sidebarMinPx,
  sidebarMaxPx,
  className,
}: SidebarWorkspaceProps) {
  const persistKey = useSidebarPersistKey();
  const savedSize = usePanelLayoutStore((s) => s.leftSizes[persistKey]);
  const setLeftSize = usePanelLayoutStore((s) => s.setLeftSize);

  const sidebarSizePx = propSidebarSizePx ?? savedSize;

  const handleLeftResize = useCallback(
    (sizePx: number) => {
      setLeftSize(persistKey, sizePx);
    },
    [persistKey, setLeftSize],
  );

  return (
    <DockWorkspace
      left={sidebar}
      main={children}
      leftPreset={preset}
      leftSizePx={sidebarSizePx}
      leftMinPx={sidebarMinPx}
      leftMaxPx={sidebarMaxPx}
      onLeftResize={handleLeftResize}
      className={className}
    />
  );
}
