import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace } from "../../dock";
import { relayoutDockviewInstances } from "../../../lib/dockviewRegistry";
import { useBottomPanelStore } from "../../../stores/bottomPanelStore";
import {
  defaultHeightForMode,
  halfHeightPx,
  resolveEmbeddedHeight,
  splitWindowHeightFromRatio,
  WS_HEIGHT_HIDDEN_MAX,
  WS_HEIGHT_TASKBAR_MAX,
} from "../../../lib/workspaceMode";

/** 程序�?resize 后短暂忽略面板回传，避免 snap 与拖拽打�?*/
const SNAP_IGNORE_MS = 120;

/** 底部工作区可拖拽的最大高度占窗口高度比例 */
const BOTTOM_PANEL_MAX_HEIGHT_RATIO = 0.95;
/** 拖拽高度超过窗口此比例时进入工程全屏 */
const WORKSPACE_FULLSCREEN_THRESHOLD_RATIO = 0.65;

function useBottomPanelDragMetrics(): { maxPx: number; fullscreenThresholdPx: number } {
  const [metrics, setMetrics] = useState(() => ({
    maxPx: Math.floor(window.innerHeight * BOTTOM_PANEL_MAX_HEIGHT_RATIO),
    fullscreenThresholdPx: Math.floor(
      window.innerHeight * WORKSPACE_FULLSCREEN_THRESHOLD_RATIO,
    ),
  }));

  useEffect(() => {
    const update = () => {
      setMetrics({
        maxPx: Math.floor(window.innerHeight * BOTTOM_PANEL_MAX_HEIGHT_RATIO),
        fullscreenThresholdPx: Math.floor(
          window.innerHeight * WORKSPACE_FULLSCREEN_THRESHOLD_RATIO,
        ),
      });
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return metrics;
}

export interface SidebarBottomProps {
  children: ReactNode;
  sidebar: ReactNode;
  sidebarSizePx?: number;
  sidebarMinPx?: number;
  sidebarMaxPx?: number;
  className?: string;
  /** task-bar 模式：固�?40px，禁止拖拽调整高�?*/
  bottomResizeLocked?: boolean;
}

/**
 * 底部可调�?可折叠边栏布局�?
 * 展开/折叠�?store 信号驱动；拖拽高度写�?store 以切�?taskbar/thumbnail/half�?
 */
export function SidebarBottom({
  children,
  sidebar,
  sidebarMinPx = 21,
  sidebarMaxPx: sidebarMaxPxProp,
  className,
  bottomResizeLocked = false,
}: SidebarBottomProps) {
  const { maxPx: computedMaxPx, fullscreenThresholdPx } = useBottomPanelDragMetrics();
  const sidebarMaxPx = bottomResizeLocked
    ? WS_HEIGHT_TASKBAR_MAX
    : (sidebarMaxPxProp ?? computedMaxPx);
  const sidebarMinPxEffective = bottomResizeLocked
    ? WS_HEIGHT_TASKBAR_MAX
    : sidebarMinPx;
  const bottomPanelRef = useRef<PanelImperativeHandle | null>(null);
  const isSnappingRef = useRef(false);
  const programmaticSyncRef = useRef(false);
  const userResizeActiveRef = useRef(false);
  const ignoreResizeUntilRef = useRef(0);
  const expandSignal = useBottomPanelStore((state) => state.expandSignal);
  const collapseSignal = useBottomPanelStore((state) => state.collapseSignal);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const workspaceHeightPx = useBottomPanelStore((state) => state.workspaceHeightPx);
  const lastNonFullscreenMode = useBottomPanelStore(
    (state) => state.lastNonFullscreenMode,
  );
  const lastExpandedHeightPx = useBottomPanelStore(
    (state) => state.lastExpandedHeightPx,
  );
  const workspaceDisplayPreference = useBottomPanelStore(
    (state) => state.workspaceDisplayPreference,
  );
  const lastExpandedHeightRatio = useBottomPanelStore(
    (state) => state.lastExpandedHeightRatio,
  );
  const setWorkspaceHeight = useBottomPanelStore((state) => state.setWorkspaceHeight);

  const targetBottomPx = bottomResizeLocked
    ? WS_HEIGHT_TASKBAR_MAX
    : workspaceMode === "hidden"
      ? 0
      : workspaceMode === "half" && workspaceDisplayPreference === "split-window"
        ? splitWindowHeightFromRatio(lastExpandedHeightRatio)
        : workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
          ? workspaceHeightPx
          : lastExpandedHeightPx > WS_HEIGHT_HIDDEN_MAX
            ? lastExpandedHeightPx
            : defaultHeightForMode(
                lastNonFullscreenMode === "hidden" ? "half" : lastNonFullscreenMode,
              );

  const shouldIgnorePanelResize = useCallback(() => {
    return (
      programmaticSyncRef.current ||
      isSnappingRef.current ||
      performance.now() < ignoreResizeUntilRef.current ||
      useBottomPanelStore.getState().isFullscreen
    );
  }, []);

  const readBottomPanelPx = useCallback((): number | null => {
    const handle = bottomPanelRef.current;
    if (!handle) return null;
    return handle.getSize().inPixels;
  }, []);

  const syncOpenState = useCallback(() => {
    if (useBottomPanelStore.getState().isFullscreen) return;
    const handle = bottomPanelRef.current;
    if (!handle) return;
    const { workspaceMode: mode } = useBottomPanelStore.getState();
    const shouldExpand =
      mode === "half" || mode === "taskbar" || mode === "thumbnail";
    const needsExpand = shouldExpand && handle.isCollapsed();
    const needsCollapse = !shouldExpand && !handle.isCollapsed();
    if (!needsExpand && !needsCollapse) return;

    programmaticSyncRef.current = true;
    ignoreResizeUntilRef.current = performance.now() + SNAP_IGNORE_MS;
    try {
      if (needsExpand) {
        handle.expand();
      } else {
        handle.collapse();
      }
    } finally {
      requestAnimationFrame(() => {
        programmaticSyncRef.current = false;
      });
    }
  }, []);

  const scheduleWorkspaceDockRelayout = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        relayoutDockviewInstances("workspace-bottom");
      });
    });
  }, []);

  const snapPanelHeight = useCallback(
    (heightPx: number) => {
      const handle = bottomPanelRef.current;
      if (!handle || useBottomPanelStore.getState().isFullscreen) return;
      isSnappingRef.current = true;
      userResizeActiveRef.current = false;
      ignoreResizeUntilRef.current = performance.now() + SNAP_IGNORE_MS;
      requestAnimationFrame(() => {
        handle.resize(`${heightPx}px`);
        requestAnimationFrame(() => {
          isSnappingRef.current = false;
          scheduleWorkspaceDockRelayout();
        });
      });
    },
    [scheduleWorkspaceDockRelayout],
  );

  const applyTargetHeight = useCallback(() => {
    if (userResizeActiveRef.current) return;
    const handle = bottomPanelRef.current;
    if (!handle || useBottomPanelStore.getState().isFullscreen) return;
    const state = useBottomPanelStore.getState();
    if (
      state.workspaceMode !== "half" &&
      state.workspaceMode !== "taskbar" &&
      state.workspaceMode !== "thumbnail"
    ) {
      return;
    }
    if (bottomResizeLocked) {
      const target = WS_HEIGHT_TASKBAR_MAX;
      const currentPx = readBottomPanelPx();
      if (currentPx != null && Math.abs(currentPx - target) <= 1) {
        return;
      }
      snapPanelHeight(target);
      if (Math.abs(state.workspaceHeightPx - target) > 1) {
        setWorkspaceHeight(target, { commit: true });
      }
      return;
    }
    const raw =
      state.workspaceMode === "half" &&
      state.workspaceDisplayPreference === "split-window"
        ? splitWindowHeightFromRatio(state.lastExpandedHeightRatio)
        : state.workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
          ? state.workspaceHeightPx
          : state.lastExpandedHeightPx > WS_HEIGHT_HIDDEN_MAX
            ? state.lastExpandedHeightPx
            : state.workspaceMode === "half"
              ? halfHeightPx()
              : defaultHeightForMode(
                  state.lastNonFullscreenMode === "hidden"
                    ? "half"
                    : state.lastNonFullscreenMode,
                );
    const { height: target } = resolveEmbeddedHeight(raw);
    const currentPx = readBottomPanelPx();
    if (currentPx != null && Math.abs(currentPx - target) <= 1) {
      return;
    }
    snapPanelHeight(target);
    if (Math.abs(state.workspaceHeightPx - target) > 1) {
      setWorkspaceHeight(target, { commit: true });
    }
  }, [
    bottomResizeLocked,
    readBottomPanelPx,
    scheduleWorkspaceDockRelayout,
    setWorkspaceHeight,
    snapPanelHeight,
  ]);

  useLayoutEffect(() => {
    syncOpenState();
  }, [workspaceMode, isFullscreen, syncOpenState]);

  // 模式切换（task-bar �?split-window）须在首帧绘制前同步面板高度，否�?dockview 会在 40px 容器�?layout
  useLayoutEffect(() => {
    if (isFullscreen) return;
    const mode = useBottomPanelStore.getState().workspaceMode;
    if (mode !== "half" && mode !== "taskbar" && mode !== "thumbnail") return;
    applyTargetHeight();
  }, [
    workspaceDisplayPreference,
    lastExpandedHeightRatio,
    workspaceMode,
    workspaceHeightPx,
    isFullscreen,
    applyTargetHeight,
  ]);

  useEffect(() => {
    if (expandSignal === 0) return;
    syncOpenState();
    applyTargetHeight();
  }, [expandSignal, syncOpenState, applyTargetHeight]);

  // split-window / task-bar：窗口尺寸变化时重算底栏高度，避免最大化后底栏被撑高
  useEffect(() => {
    let raf = 0;
    const onViewportResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const state = useBottomPanelStore.getState();
        if (state.isFullscreen) return;
        if (bottomResizeLocked) {
          applyTargetHeight();
          return;
        }
        if (
          state.workspaceMode === "half" &&
          state.workspaceDisplayPreference === "split-window"
        ) {
          applyTargetHeight();
          return;
        }
        if (state.workspaceMode === "taskbar" || state.workspaceMode === "thumbnail") {
          applyTargetHeight();
          return;
        }
        scheduleWorkspaceDockRelayout();
      });
    };
    window.addEventListener("resize", onViewportResize);
    return () => {
      window.removeEventListener("resize", onViewportResize);
      cancelAnimationFrame(raf);
    };
  }, [applyTargetHeight, bottomResizeLocked, scheduleWorkspaceDockRelayout]);

  useEffect(() => {
    if (collapseSignal === 0) return;
    const handle = bottomPanelRef.current;
    if (!handle || handle.isCollapsed()) return;
    programmaticSyncRef.current = true;
    ignoreResizeUntilRef.current = performance.now() + SNAP_IGNORE_MS;
    handle.collapse();
    requestAnimationFrame(() => {
      programmaticSyncRef.current = false;
    });
  }, [collapseSignal]);

  const enterFullscreenFromDrag = useCallback(
    (heightPx: number) => {
      const store = useBottomPanelStore.getState();
      if (store.isFullscreen) return;
      userResizeActiveRef.current = false;
      const capped = Math.min(heightPx, fullscreenThresholdPx - 1);
      const { mode, height } = resolveEmbeddedHeight(capped);
      useBottomPanelStore.setState({
        workspaceHeightPx: height,
        lastNonFullscreenMode: mode,
      });
      store.enterWorkspaceFullscreen();
    },
    [fullscreenThresholdPx],
  );

  const processLiveResize = useCallback(
    (heightPx: number) => {
      const store = useBottomPanelStore.getState();
      if (store.isFullscreen) return;
      if (heightPx <= WS_HEIGHT_HIDDEN_MAX && store.workspaceMode === "hidden") {
        return;
      }
      setWorkspaceHeight(heightPx, { commit: false });
    },
    [setWorkspaceHeight],
  );

  /** 用户拖拽分隔条时�?react-resizable-panels �?onLayoutChange 驱动（跟手切模式�?*/
  const handleBottomLayoutChange = useCallback(() => {
    if (bottomResizeLocked || shouldIgnorePanelResize()) return;
    // 程序�?expand/snap 也会触发 onLayoutChange，不可当作用户拖�?
    if (programmaticSyncRef.current || isSnappingRef.current) return;
    userResizeActiveRef.current = true;
    const px = readBottomPanelPx();
    if (px == null) return;
    processLiveResize(px);
  }, [bottomResizeLocked, processLiveResize, readBottomPanelPx, shouldIgnorePanelResize]);

  /** 用户按下底部分隔条：立刻取消程序�?snap 的忽略窗口，避免首次拖拽�?resize 回写吃掉 */
  const handleBottomHandlePointerDown = useCallback(() => {
    if (bottomResizeLocked) return;
    ignoreResizeUntilRef.current = 0;
    programmaticSyncRef.current = false;
    isSnappingRef.current = false;
    userResizeActiveRef.current = true;
  }, [bottomResizeLocked]);

  /** 松手提交：onLayoutChanged 在指针释放后触发 */
  const handleBottomLayoutChanged = useCallback(() => {
    if (bottomResizeLocked || shouldIgnorePanelResize()) return;
    if (!userResizeActiveRef.current) return;
    userResizeActiveRef.current = false;

    const store = useBottomPanelStore.getState();
    const px = readBottomPanelPx();
    if (px == null) return;

    if (px >= fullscreenThresholdPx) {
      enterFullscreenFromDrag(px);
      return;
    }
    if (px <= WS_HEIGHT_HIDDEN_MAX) {
      if (store.workspaceMode === "hidden") return;
      store.requestCollapse();
      return;
    }
    setWorkspaceHeight(px, { fromUserDrag: true, commit: true });
    const target = useBottomPanelStore.getState().workspaceHeightPx;
    if (Math.abs(px - target) > 1) {
      snapPanelHeight(target);
    }
  }, [
    enterFullscreenFromDrag,
    fullscreenThresholdPx,
    readBottomPanelPx,
    setWorkspaceHeight,
    shouldIgnorePanelResize,
    snapPanelHeight,
  ]);

  return (
    <DockWorkspace
      main={children}
      bottom={sidebar}
      bottomSizePx={targetBottomPx}
      bottomMinPx={sidebarMinPxEffective}
      bottomMaxPx={sidebarMaxPx}
      bottomHandleDisabled={bottomResizeLocked}
      bottomPanelRef={bottomPanelRef}
      onBottomLayoutChange={handleBottomLayoutChange}
      onBottomResizeEnd={handleBottomLayoutChanged}
      onBottomHandlePointerDown={handleBottomHandlePointerDown}
      className={className}
    />
  );
}
