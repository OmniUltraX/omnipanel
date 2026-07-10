import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 所有模块左侧资源侧栏共用同一宽度持久化 key */
export const MODULE_LEFT_SIDEBAR_LAYOUT_KEY = "module-left-sidebar";

export const MODULE_LEFT_SIDEBAR_MIN_PX = 180;
export const MODULE_LEFT_SIDEBAR_MAX_PX = 420;
export const MODULE_LEFT_SIDEBAR_DEFAULT_PX = 260;

const LEGACY_LEFT_SIDEBAR_KEYS = [
  "database",
  "files",
  "knowledge",
  "terminal-sessions",
  "docker-connections",
  "server-panels",
  "ssh",
  "ssh-hosts",
  "workflow",
  "protocol-http",
  "protocol-mqtt",
  "protocol-serial",
  "protocol-websocket",
] as const;

export function getModuleLeftSidebarSize(leftSizes: Record<string, number>): number | undefined {
  const shared = leftSizes[MODULE_LEFT_SIDEBAR_LAYOUT_KEY];
  if (typeof shared === "number" && shared >= MODULE_LEFT_SIDEBAR_MIN_PX) {
    return shared;
  }
  return undefined;
}

function migrateLegacyLeftSidebarSizes(leftSizes: Record<string, number>): Record<string, number> {
  if (getModuleLeftSidebarSize(leftSizes) != null) {
    return leftSizes;
  }
  const legacyValues = [
    ...LEGACY_LEFT_SIDEBAR_KEYS.map((key) => leftSizes[key]),
    ...Object.entries(leftSizes)
      .filter(([key]) => key.startsWith("protocol-"))
      .map(([, value]) => value),
  ].filter((value): value is number => typeof value === "number" && value >= MODULE_LEFT_SIDEBAR_MIN_PX);
  if (legacyValues.length === 0) {
    return leftSizes;
  }
  return {
    ...leftSizes,
    [MODULE_LEFT_SIDEBAR_LAYOUT_KEY]: Math.max(...legacyValues),
  };
}

/** 数据库同步工具箱：源库面板宽度占比（0–100） */
export const DB_TOOLBOX_SYNC_SPLIT_KEY = "database-toolbox-sync-split";
export const DB_TOOLBOX_SYNC_SPLIT_DEFAULT = 50;
export const DB_TOOLBOX_SYNC_SPLIT_MIN = 22;
export const DB_TOOLBOX_SYNC_SPLIT_MAX = 78;

export function getDbToolboxSyncSourceRatio(splitRatios: Record<string, number>): number {
  const raw = splitRatios[DB_TOOLBOX_SYNC_SPLIT_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DB_TOOLBOX_SYNC_SPLIT_DEFAULT;
  }
  return Math.min(DB_TOOLBOX_SYNC_SPLIT_MAX, Math.max(DB_TOOLBOX_SYNC_SPLIT_MIN, raw));
}

interface PanelLayoutState {
  leftSizes: Record<string, number>;
  rightSizes: Record<string, number>;
  splitRatios: Record<string, number>;
  /** 所有模块左侧资源侧栏共用折叠状态 */
  moduleLeftSidebarCollapsed: boolean;
  /** 递增信号：Shell 侧栏重复点击当前模块时触发侧栏折叠切换 */
  moduleSidebarToggleNonce: number;
  setLeftSize: (key: string, size: number) => void;
  setModuleLeftSidebarSize: (size: number) => void;
  setModuleLeftSidebarCollapsed: (collapsed: boolean) => void;
  setRightSize: (key: string, size: number) => void;
  setSplitRatio: (key: string, percent: number) => void;
  toggleModuleSidebar: () => void;
}

export const usePanelLayoutStore = create<PanelLayoutState>()(
  persist(
    (set) => ({
      leftSizes: {},
      rightSizes: {},
      splitRatios: {},
      moduleLeftSidebarCollapsed: false,
      moduleSidebarToggleNonce: 0,

      setLeftSize: (key, size) =>
        set((state) => ({
          leftSizes: { ...state.leftSizes, [key]: size },
        })),

      setModuleLeftSidebarSize: (size) =>
        set((state) => ({
          leftSizes: { ...state.leftSizes, [MODULE_LEFT_SIDEBAR_LAYOUT_KEY]: size },
        })),

      setModuleLeftSidebarCollapsed: (collapsed) =>
        set({ moduleLeftSidebarCollapsed: collapsed }),

      setRightSize: (key, size) =>
        set((state) => ({
          rightSizes: { ...state.rightSizes, [key]: size },
        })),

      setSplitRatio: (key, percent) =>
        set((state) => ({
          splitRatios: { ...state.splitRatios, [key]: percent },
        })),

      toggleModuleSidebar: () =>
        set((state) => ({
          moduleSidebarToggleNonce: state.moduleSidebarToggleNonce + 1,
        })),
    }),
    {
      name: "omnipanel-panel-layout",
      version: 4,
      migrate: (persistedState) => {
        const state = persistedState as {
          leftSizes?: Record<string, number>;
          rightSizes?: Record<string, number>;
          splitRatios?: Record<string, number>;
          moduleLeftSidebarCollapsed?: boolean;
        };
        const leftSizes = migrateLegacyLeftSidebarSizes(state.leftSizes ?? {});
        return {
          ...state,
          leftSizes,
          splitRatios: state.splitRatios ?? {},
          moduleLeftSidebarCollapsed: state.moduleLeftSidebarCollapsed ?? false,
        };
      },
      partialize: (state) => ({
        leftSizes: state.leftSizes,
        rightSizes: state.rightSizes,
        splitRatios: state.splitRatios,
        moduleLeftSidebarCollapsed: state.moduleLeftSidebarCollapsed,
      }),
    },
  ),
);
