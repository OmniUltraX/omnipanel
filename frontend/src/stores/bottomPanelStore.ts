import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  defaultHeightForMode,
  dragModeFromHeight,
  isEmbeddedWorkspaceMode,
  modeFromHeight,
  normalizeWorkspaceHeight,
  WS_HEIGHT_HIDDEN_MAX,
  type EmbeddedWorkspaceMode,
  type WorkspaceMode,
} from "../lib/workspaceMode";

/** @deprecated 兼容旧逻辑，映射到 hidden/half */
export type WorkspaceEmbeddedMode = "off" | "half";

interface BottomPanelState {
  expandSignal: number;
  collapseSignal: number;
  /** 当前工作区模式 */
  workspaceMode: WorkspaceMode;
  /** 底部嵌入区实际高度（px） */
  workspaceHeightPx: number;
  /** 离开全屏前记住的嵌入模式 */
  lastNonFullscreenMode: EmbeddedWorkspaceMode;

  /** 底部工作区是否展开（嵌入态且非 hidden） */
  isOpen: boolean;
  /** 是否全屏（工程或首页） */
  isFullscreen: boolean;
  /** 是否首页全屏 */
  isHomeActive: boolean;
  /** @deprecated 使用 lastNonFullscreenMode */
  embeddedMode: WorkspaceEmbeddedMode;

  requestExpand: () => void;
  requestCollapse: () => void;
  setIsOpen: (open: boolean) => void;
  setWorkspaceHeight: (
    heightPx: number,
    options?: { fromUserDrag?: boolean; commit?: boolean },
  ) => void;
  enterFullscreen: () => void;
  enterHomeWorkspace: () => void;
  enterWorkspaceFullscreen: () => void;
  exitFullscreen: () => void;
  leaveFullscreenForFeature: () => void;
  leaveHomeToFeature: () => void;
  exitHomeToWorkspace: () => void;
  applyEmbeddedMode: () => void;
  toggleFullscreen: () => void;
  toggleEmbeddedWorkspace: () => void;
  toggleOpen: () => void;
  /** 全屏顶栏向下拖拽退出全屏 */
  leaveFullscreenByDrag: (heightPx: number) => void;
  /** 半屏及以下右上角：先进工程全屏；工程全屏再进首页 */
  handleWorkspaceChromeIcon: () => void;
}

function syncDerivedFlags(mode: WorkspaceMode): Pick<
  BottomPanelState,
  "isOpen" | "isFullscreen" | "isHomeActive" | "embeddedMode"
> {
  const isFullscreen = mode === "fullscreen" || mode === "home";
  const isHomeActive = mode === "home";
  const isOpen = isEmbeddedWorkspaceMode(mode) && mode !== "hidden";
  const embeddedMode: WorkspaceEmbeddedMode =
    mode === "half" || mode === "thumbnail" || mode === "taskbar" ? "half" : "off";
  return { isOpen, isFullscreen, isHomeActive, embeddedMode };
}

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set, get) => ({
      expandSignal: 0,
      collapseSignal: 0,
      workspaceMode: "hidden",
      workspaceHeightPx: 0,
      lastNonFullscreenMode: "half",
      isOpen: false,
      isFullscreen: false,
      isHomeActive: false,
      embeddedMode: "off",

      requestExpand: () => {
        const { lastNonFullscreenMode } = get();
        const mode: EmbeddedWorkspaceMode =
          lastNonFullscreenMode === "taskbar" ||
          lastNonFullscreenMode === "thumbnail"
            ? lastNonFullscreenMode
            : "half";
        const height = defaultHeightForMode(mode);
        set((state) => ({
          expandSignal: state.expandSignal + 1,
          workspaceMode: mode,
          workspaceHeightPx: height,
          lastNonFullscreenMode: mode,
          ...syncDerivedFlags(mode),
        }));
      },

      requestCollapse: () => {
        const { workspaceMode, lastNonFullscreenMode } = get();
        const remembered =
          isEmbeddedWorkspaceMode(workspaceMode) && workspaceMode !== "hidden"
            ? workspaceMode
            : lastNonFullscreenMode;
        set((state) => ({
          collapseSignal: state.collapseSignal + 1,
          workspaceMode: "hidden",
          workspaceHeightPx: 0,
          lastNonFullscreenMode: remembered,
          ...syncDerivedFlags("hidden"),
        }));
      },

      setIsOpen: (isOpen) => {
        if (isOpen) {
          get().requestExpand();
        } else {
          get().requestCollapse();
        }
      },

      setWorkspaceHeight: (heightPx, options) => {
        const { workspaceMode } = get();
        if (workspaceMode === "fullscreen" || workspaceMode === "home") return;

        const currentEmbedded = isEmbeddedWorkspaceMode(workspaceMode)
          ? workspaceMode
          : undefined;

        // 拖拽进行中：只切换渲染形态，不动高度/记忆值，让面板跟手不回弹。
        if (options?.commit === false) {
          const liveMode = dragModeFromHeight(heightPx, currentEmbedded);
          if (liveMode === workspaceMode) return;
          set({ workspaceMode: liveMode, ...syncDerivedFlags(liveMode) });
          return;
        }

        // 松手提交：吸附到规范高度并记忆。
        const nextMode = dragModeFromHeight(heightPx, currentEmbedded);
        const normalized = normalizeWorkspaceHeight(heightPx, nextMode);
        const patch: Partial<BottomPanelState> = {
          workspaceHeightPx: normalized,
          workspaceMode: nextMode,
          ...syncDerivedFlags(nextMode),
        };
        if (nextMode !== "hidden") {
          patch.lastNonFullscreenMode = nextMode;
        }
        set(patch);
      },

      enterFullscreen: () => {
        get().enterHomeWorkspace();
      },

      enterHomeWorkspace: () => {
        set((state) => ({
          workspaceMode: "home",
          expandSignal: state.expandSignal + 1,
          ...syncDerivedFlags("home"),
        }));
      },

      enterWorkspaceFullscreen: () => {
        set((state) => ({
          workspaceMode: "fullscreen",
          expandSignal: state.expandSignal + 1,
          ...syncDerivedFlags("fullscreen"),
        }));
      },

      exitHomeToWorkspace: () => {
        get().enterWorkspaceFullscreen();
      },

      applyEmbeddedMode: () => {
        const { lastNonFullscreenMode } = get();
        const mode: EmbeddedWorkspaceMode =
          lastNonFullscreenMode === "hidden" ? "half" : lastNonFullscreenMode;
        const height = defaultHeightForMode(mode);
        set((state) => ({
          expandSignal: state.expandSignal + 1,
          workspaceMode: mode,
          workspaceHeightPx: height,
          ...syncDerivedFlags(mode),
        }));
      },

      exitFullscreen: () => {
        set({ isFullscreen: false, isHomeActive: false });
        get().applyEmbeddedMode();
      },

      leaveFullscreenForFeature: () => {
        const { workspaceMode } = get();
        if (workspaceMode !== "fullscreen" && workspaceMode !== "home") return;
        set({ isFullscreen: false, isHomeActive: false });
        get().applyEmbeddedMode();
      },

      leaveHomeToFeature: () => {
        get().leaveFullscreenForFeature();
      },

      leaveFullscreenByDrag: (heightPx) => {
        const { lastNonFullscreenMode } = get();
        const currentEmbedded =
          lastNonFullscreenMode !== "hidden" ? lastNonFullscreenMode : undefined;
        const nextMode = modeFromHeight(heightPx, currentEmbedded);
        const normalized = normalizeWorkspaceHeight(heightPx, nextMode);
        set({
          workspaceMode: nextMode,
          workspaceHeightPx: normalized,
          lastNonFullscreenMode: nextMode === "hidden" ? get().lastNonFullscreenMode : nextMode,
          ...syncDerivedFlags(nextMode),
        });
        if (nextMode !== "hidden") {
          set((state) => ({ expandSignal: state.expandSignal + 1 }));
        } else {
          set((state) => ({ collapseSignal: state.collapseSignal + 1 }));
        }
      },

      handleWorkspaceChromeIcon: () => {
        const { workspaceMode } = get();
        if (workspaceMode === "fullscreen") {
          get().enterHomeWorkspace();
          return;
        }
        if (workspaceMode === "home") return;
        get().enterWorkspaceFullscreen();
      },

      toggleFullscreen: () => {
        const { workspaceMode } = get();
        if (workspaceMode === "fullscreen" || workspaceMode === "home") {
          get().exitFullscreen();
        } else {
          get().enterHomeWorkspace();
        }
      },

      toggleEmbeddedWorkspace: () => {
        const { workspaceMode } = get();
        if (workspaceMode === "hidden") {
          get().requestExpand();
        } else if (isEmbeddedWorkspaceMode(workspaceMode)) {
          get().requestCollapse();
        }
      },

      toggleOpen: () => {
        const { workspaceMode } = get();
        if (workspaceMode === "fullscreen" || workspaceMode === "home") {
          get().exitFullscreen();
          return;
        }
        if (workspaceMode === "hidden") {
          const height = defaultHeightForMode("half");
          set((state) => ({
            expandSignal: state.expandSignal + 1,
            workspaceMode: "half",
            workspaceHeightPx: height,
            lastNonFullscreenMode: "half",
            ...syncDerivedFlags("half"),
          }));
        } else {
          get().requestCollapse();
        }
      },
    }),
    {
      name: "omnipanel-bottom-panel",
      version: 2,
      partialize: (state) => ({
        lastNonFullscreenMode: state.lastNonFullscreenMode,
        workspaceHeightPx: state.workspaceHeightPx,
        embeddedMode: state.embeddedMode,
      }),
      migrate: (persisted, version) => {
        const p = persisted as Record<string, unknown> | undefined;
        if (!p || version >= 2) return persisted as unknown as BottomPanelState;
        const legacyEmbedded = p.embeddedMode === "half" ? "half" : "off";
        const lastNonFullscreenMode: EmbeddedWorkspaceMode = "half";
        const workspaceHeightPx =
          typeof p.workspaceHeightPx === "number"
            ? p.workspaceHeightPx
            : defaultHeightForMode("half");
        const workspaceMode: WorkspaceMode =
          legacyEmbedded === "half" ? "half" : "hidden";
        return {
          ...p,
          lastNonFullscreenMode,
          workspaceHeightPx: legacyEmbedded === "half" ? workspaceHeightPx : 0,
          workspaceMode,
          embeddedMode: legacyEmbedded,
        } as BottomPanelState;
      },
      merge: (persisted, current) => {
        const p = persisted as Partial<BottomPanelState> | undefined;
        if (!p) return current;
        const merged = { ...current, ...p };
        if (p.embeddedMode === "half") {
          const mode: EmbeddedWorkspaceMode =
            p.lastNonFullscreenMode && p.lastNonFullscreenMode !== "hidden"
              ? p.lastNonFullscreenMode
              : "half";
          merged.workspaceMode = mode;
          const rawHeight =
            typeof p.workspaceHeightPx === "number" && p.workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
              ? p.workspaceHeightPx
              : defaultHeightForMode(mode);
          merged.workspaceHeightPx = normalizeWorkspaceHeight(rawHeight, mode);
          Object.assign(merged, syncDerivedFlags(mode));
        } else {
          merged.workspaceMode = "hidden";
          merged.workspaceHeightPx = 0;
          Object.assign(merged, syncDerivedFlags("hidden"));
        }
        return merged;
      },
    },
  ),
);

/** 当前嵌入态（非全屏时） */
export function useEmbeddedWorkspaceMode(): EmbeddedWorkspaceMode {
  const mode = useBottomPanelStore((s) => s.workspaceMode);
  if (isEmbeddedWorkspaceMode(mode)) return mode;
  return "hidden";
}
