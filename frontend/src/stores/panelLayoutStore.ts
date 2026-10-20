import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 旧版「所有模块共用一条宽度」的持久化 key。
 * 新写入按模块分开；尚未单独拖过的模块仍回落到这条宽度，避免升级后突然变宽。
 */
export const MODULE_LEFT_SIDEBAR_LAYOUT_KEY = "module-left-sidebar";

/** 某个模块左侧栏宽度在 leftSizes 里的 key */
export function moduleLeftSidebarSizeKey(layoutKey: string): string {
  return `module-left:${layoutKey}`;
}

export const MODULE_LEFT_SIDEBAR_MIN_PX = 180;
/** 模块左侧资源侧栏最大宽度占应用窗口宽度的比例 */
export const MODULE_LEFT_SIDEBAR_MAX_RATIO = 0.4;
/** 传给 react-resizable-panels 的左侧栏 maxSize（相对组宽） */
export const MODULE_LEFT_SIDEBAR_MAX_SIZE = "40%";
/**
 * 固定像素上限（仅用于右侧栏等仍按绝对像素约束的场景）。
 * 左侧模块侧栏请使用 {@link MODULE_LEFT_SIDEBAR_MAX_SIZE} / {@link getModuleLeftSidebarMaxPx}。
 */
export const MODULE_LEFT_SIDEBAR_MAX_PX = 420;
export const MODULE_LEFT_SIDEBAR_DEFAULT_PX = 260;

/** 按当前应用窗口宽度计算左侧栏最大像素宽（默认 40%） */
export function getModuleLeftSidebarMaxPx(
  containerWidth = typeof window !== "undefined" ? window.innerWidth : 1920,
): number {
  return Math.max(
    MODULE_LEFT_SIDEBAR_MIN_PX,
    Math.floor(containerWidth * MODULE_LEFT_SIDEBAR_MAX_RATIO),
  );
}

/** 将左侧栏宽度钳制到 [min, 视口 40%] */
export function clampModuleLeftSidebarSize(
  size: number,
  containerWidth?: number,
): number {
  const max = getModuleLeftSidebarMaxPx(containerWidth);
  return Math.min(max, Math.max(MODULE_LEFT_SIDEBAR_MIN_PX, size));
}

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

export function getModuleLeftSidebarSize(
  leftSizes: Record<string, number>,
  layoutKey?: string,
): number | undefined {
  if (layoutKey) {
    const own = leftSizes[moduleLeftSidebarSizeKey(layoutKey)];
    if (typeof own === "number" && own >= MODULE_LEFT_SIDEBAR_MIN_PX) {
      return own;
    }
  }
  const shared = leftSizes[MODULE_LEFT_SIDEBAR_LAYOUT_KEY];
  if (typeof shared === "number" && shared >= MODULE_LEFT_SIDEBAR_MIN_PX) {
    return shared;
  }
  return undefined;
}

/** 只认该模块自己记下的折叠。没有记录就是展开，不继承旧的全局折叠。 */
export function getModuleLeftSidebarCollapsed(
  collapsedByKey: Record<string, boolean> | undefined,
  layoutKey: string,
): boolean {
  return collapsedByKey?.[layoutKey] === true;
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
  /**
   * 尚未单独折叠过的模块回落到这个值。
   * 新的折叠只写 {@link moduleLeftSidebarCollapsedByKey}。
   */
  moduleLeftSidebarCollapsed: boolean;
  /** 各模块左侧栏是否折叠 */
  moduleLeftSidebarCollapsedByKey: Record<string, boolean>;
  /** 递增信号：Shell 侧栏重复点击当前模块时触发侧栏折叠切换 */
  moduleSidebarToggleNonce: number;
  setLeftSize: (key: string, size: number) => void;
  setModuleLeftSidebarSize: (layoutKey: string, size: number) => void;
  setModuleLeftSidebarCollapsed: (layoutKey: string, collapsed: boolean) => void;
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
      moduleLeftSidebarCollapsedByKey: {},
      moduleSidebarToggleNonce: 0,

      setLeftSize: (key, size) =>
        set((state) => ({
          leftSizes: { ...state.leftSizes, [key]: size },
        })),

      setModuleLeftSidebarSize: (layoutKey, size) =>
        set((state) => ({
          leftSizes: {
            ...state.leftSizes,
            [moduleLeftSidebarSizeKey(layoutKey)]: clampModuleLeftSidebarSize(size),
          },
        })),

      setModuleLeftSidebarCollapsed: (layoutKey, collapsed) =>
        set((state) => ({
          moduleLeftSidebarCollapsedByKey: {
            ...state.moduleLeftSidebarCollapsedByKey,
            [layoutKey]: collapsed,
          },
        })),

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
        moduleLeftSidebarCollapsedByKey: state.moduleLeftSidebarCollapsedByKey,
      }),
    },
  ),
);
