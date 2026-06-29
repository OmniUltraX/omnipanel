import { useCallback, useRef, type ReactNode } from "react";import { DockWorkspace, type DockRailPreset } from "../dock";
import {
  getModuleLeftSidebarSize,
  MODULE_LEFT_SIDEBAR_MAX_PX,
  MODULE_LEFT_SIDEBAR_MIN_PX,
  usePanelLayoutStore,
} from "../../stores/panelLayoutStore";

/** 侧栏宽度预设（像素级默认值见 DockWorkspace） */
export type SidebarWorkspacePreset = DockRailPreset;

const SIDEBAR_MIN_BY_PRESET: Record<SidebarWorkspacePreset, number> = {
  default: MODULE_LEFT_SIDEBAR_MIN_PX,
  schema: MODULE_LEFT_SIDEBAR_MIN_PX,
  host: MODULE_LEFT_SIDEBAR_MIN_PX,
  server: MODULE_LEFT_SIDEBAR_MIN_PX,
  settings: MODULE_LEFT_SIDEBAR_MIN_PX,
  ai: MODULE_LEFT_SIDEBAR_MIN_PX,
};

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
  /** @deprecated 侧栏宽度已全局共用，此字段保留兼容、不再参与持久化 */
  layoutPersistKey?: string;
  className?: string;
}

/**
 * 模块工作区布局：左侧可调整/可折叠边栏 + 主内容。
 * 基于 DockWorkspace，供 SSH、服务器、数据库等模块复用。
 *
 * 左侧面板宽度在所有模块间共用并持久化。
 */
export function SidebarWorkspace({
  sidebar,
  children,
  preset = "default",
  sidebarSizePx: propSidebarSizePx,
  sidebarMinPx,
  sidebarMaxPx = MODULE_LEFT_SIDEBAR_MAX_PX,
  layoutPersistKey: _layoutPersistKey,
  className,
}: SidebarWorkspaceProps) {
  const savedSize = usePanelLayoutStore((s) => getModuleLeftSidebarSize(s.leftSizes));
  const setModuleLeftSidebarSize = usePanelLayoutStore((s) => s.setModuleLeftSidebarSize);

  const sidebarSizePx = propSidebarSizePx ?? savedSize;
  const pendingLeftSizeRef = useRef<number | null>(null);

  const handleLeftResize = useCallback((sizePx: number) => {
    pendingLeftSizeRef.current = sizePx;
  }, []);

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current;
    if (size == null) return;
    if (size < MODULE_LEFT_SIDEBAR_MIN_PX) {
      pendingLeftSizeRef.current = null;
      return;
    }
    setModuleLeftSidebarSize(size);
    pendingLeftSizeRef.current = null;
  }, [setModuleLeftSidebarSize]);

  return (
    <DockWorkspace
      left={sidebar}
      main={children}
      leftPreset={preset}
      leftSizePx={sidebarSizePx}
      leftMinPx={sidebarMinPx ?? SIDEBAR_MIN_BY_PRESET[preset]}
      leftMaxPx={sidebarMaxPx}
      onLeftResize={handleLeftResize}
      onLeftLayoutChanged={handleLeftLayoutChanged}
      className={className}
    />
  );
}
