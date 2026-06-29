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

interface PanelLayoutState {
  leftSizes: Record<string, number>;
  rightSizes: Record<string, number>;
  setLeftSize: (key: string, size: number) => void;
  setModuleLeftSidebarSize: (size: number) => void;
  setRightSize: (key: string, size: number) => void;
}

export const usePanelLayoutStore = create<PanelLayoutState>()(
  persist(
    (set) => ({
      leftSizes: {},
      rightSizes: {},

      setLeftSize: (key, size) =>
        set((state) => ({
          leftSizes: { ...state.leftSizes, [key]: size },
        })),

      setModuleLeftSidebarSize: (size) =>
        set((state) => ({
          leftSizes: { ...state.leftSizes, [MODULE_LEFT_SIDEBAR_LAYOUT_KEY]: size },
        })),

      setRightSize: (key, size) =>
        set((state) => ({
          rightSizes: { ...state.rightSizes, [key]: size },
        })),
    }),
    {
      name: "omnipanel-panel-layout",
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as { leftSizes?: Record<string, number>; rightSizes?: Record<string, number> };
        const leftSizes = migrateLegacyLeftSidebarSizes(state.leftSizes ?? {});
        return { ...state, leftSizes };
      },
      partialize: (state) => ({
        leftSizes: state.leftSizes,
        rightSizes: state.rightSizes,
      }),
    },
  ),
);
