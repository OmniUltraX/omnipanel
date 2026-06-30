import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { DockWorkspace, type DockRailPreset } from "../dock";
import {
  MODULE_LEFT_SIDEBAR_MAX_PX,
  usePanelLayoutStore,
} from "../../stores/panelLayoutStore";

/** 侧栏宽度预设（像素级默认值见 DockWorkspace） */
export type RightSidebarWorkspacePreset = DockRailPreset;

const SIDEBAR_MIN_BY_PRESET: Record<RightSidebarWorkspacePreset, number> = {
  default: 220,
  schema: 280,
  host: 240,
  server: 200,
  settings: 180,
  ai: 200,
};

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
  /** 侧栏最大宽度（px） */
  sidebarMaxPx?: number;
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

  const effectiveMinSize = sidebarMinPx ?? SIDEBAR_MIN_BY_PRESET[preset];
  const usableSavedSize =
    typeof savedSize === "number" && savedSize >= effectiveMinSize
      ? savedSize
      : undefined;
  const sidebarSizePx = propSidebarSizePx ?? usableSavedSize;
  const pendingRightSizeRef = useRef<number | null>(null);

  const handleRightResize = useCallback((sizePx: number) => {
    pendingRightSizeRef.current = sizePx;
  }, []);

  const handleRightLayoutChanged = useCallback(() => {
    const size = pendingRightSizeRef.current;
    if (size == null) return;
    if (size < effectiveMinSize) {
      pendingRightSizeRef.current = null;
      return;
    }
    setRightSize(persistKey, size);
    pendingRightSizeRef.current = null;
  }, [effectiveMinSize, persistKey, setRightSize]);

  return (
    <DockWorkspace
      main={children}
      right={sidebar}
      rightPreset={preset}
      rightSizePx={sidebarSizePx}
      rightMinPx={sidebarMinPx}
      rightMaxPx={sidebarMaxPx ?? MODULE_LEFT_SIDEBAR_MAX_PX}
      onRightResize={handleRightResize}
      onRightLayoutChanged={handleRightLayoutChanged}
      className={className}
    />
  );
}
