import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { SidebarBottom } from "../sidebar/SidebarBottom";
import { WorkspacePreviewTaskBar } from "./WorkspacePreviewTaskBar";
import { WorkspaceBottomHost } from "../../workspace/WorkspaceBottomHost";
import { useBottomPanelStore, useEmbeddedWorkspaceMode } from "../../../stores/bottomPanelStore";
import { relayoutDockviewInstances } from "../../../lib/dockviewRegistry";
import { measureFullscreenWorkspaceDockSize } from "../../../lib/workspaceDockMeasure";
import { syncEmbeddedWorkspacePanelVisibility } from "../../../lib/workspaceTabActions";
import { useWorkspaceWindowStore } from "../../../stores/workspaceWindowStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import {
  requestWorkspaceDockWarmup,
  useWorkspaceDockWarmupStore,
} from "../../../stores/workspaceDockWarmupStore";
import {
  WS_HEIGHT_HIDDEN_MAX,
  type WorkspaceDisplayPreference,
} from "../../../lib/workspaceMode";
import { isDashboardPath } from "../../../lib/paths";

export type WorkspacePreviewDisplayMode = "split-window" | "task-bar";

export interface WorkspacePreviewProps {
  children: ReactNode;
  className?: string;
}

function resolveDisplayMode(
  embeddedMode: ReturnType<typeof useEmbeddedWorkspaceMode>,
  preference: WorkspaceDisplayPreference,
): WorkspacePreviewDisplayMode {
  if (embeddedMode === "hidden") return "task-bar";
  if (preference === "task-bar" || embeddedMode === "taskbar") return "task-bar";
  return "split-window";
}

/**
 * 全屏 dock relayout 的唯一入口（resize / 进入全屏）。
 * WorkspaceBottomHost 只负责非全屏 ResizeObserver 与切换工作区后的补一次 layout。
 */
function useWorkspaceFullscreenDockRelayout(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const relayout = () => {
      const { width, height } = measureFullscreenWorkspaceDockSize();
      if (width <= 0 || height <= 0) return;
      relayoutDockviewInstances("workspace-bottom", { width, height });
    };

    relayout();
    window.addEventListener("resize", relayout);
    return () => window.removeEventListener("resize", relayout);
  }, [enabled]);
}

/**
 * 工作区预览布局：主内容 + 可拖拽底部工作区。
 * - split-window：分屏高度，dockview 展示全部面板
 * - task-bar：标签栏高度（40px），浏览器式标签栏
 * 显示模式由 `workspaceDisplayPreference` 用户偏好决定，持久化于 bottomPanelStore。
 */
export function WorkspacePreview({ children, className }: WorkspacePreviewProps) {
  const location = useLocation();
  const isHomeRoute = isDashboardPath(location.pathname);
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const embeddedMode = useEmbeddedWorkspaceMode();
  /** 底部工作区是否展开：以 bottomPanelStore 为唯一来源，避免与 preview store 双向同步死循环 */
  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const poppedOutIds = useWorkspaceWindowStore((state) => state.poppedOutIds);
  const hasHostedWorkspace = workspaces.some((ws) => !poppedOutIds.includes(ws.id));
  const isCurrentWorkspacePoppedOut =
    poppedOutIds.includes(workspace.id) && !(isFullscreen && hasHostedWorkspace);
  const workspaceDisplayPreference = useBottomPanelStore(
    (state) => state.workspaceDisplayPreference,
  );
  const dockWarm = useWorkspaceDockWarmupStore((state) => state.warm);

  const displayMode = resolveDisplayMode(embeddedMode, workspaceDisplayPreference);
  const isPreviewOpen =
    !isHomeRoute &&
    !isFullscreen &&
    workspaceMode !== "hidden" &&
    embeddedMode !== "hidden" &&
    !isCurrentWorkspacePoppedOut;
  const isPreviewCollapsed = !isPreviewOpen;
  const isBottomPanelOpen = isPreviewOpen;
  const showSplitWindow = isBottomPanelOpen && displayMode === "split-window";
  const showTaskBar = isBottomPanelOpen && displayMode === "task-bar";
  const bottomStackRef = useRef<HTMLDivElement>(null);

  // 首页挂起 panel 内容：只保活 dockview shell，避免 Schema/表格虚拟列表空跑
  const contentSuspended = isHomeRoute && !isFullscreen;

  useWorkspaceFullscreenDockRelayout(isFullscreen);

  // 非全屏分屏：由 bottom stack 尺寸驱动（ResizeObserver）
  useEffect(() => {
    if (!showSplitWindow || isFullscreen) return;
    const stackEl = bottomStackRef.current;
    if (!stackEl) return;

    let lastStackW = 0;
    let lastStackH = 0;
    let raf = 0;

    const relayoutFromStack = (width: number, height: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (width <= 0 || height <= 0) return;
        relayoutDockviewInstances("workspace-bottom", { width, height });
      });
    };

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (
        Math.abs(rect.width - lastStackW) < 1 &&
        Math.abs(rect.height - lastStackH) < 1
      ) {
        return;
      }
      lastStackW = rect.width;
      lastStackH = rect.height;
      relayoutFromStack(rect.width, rect.height);
    });
    observer.observe(stackEl);

    const initial = stackEl.getBoundingClientRect();
    if (initial.width > 0 && initial.height > 0) {
      lastStackW = initial.width;
      lastStackH = initial.height;
      relayoutFromStack(initial.width, initial.height);
    }

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [showSplitWindow, isFullscreen]);

  const wasFullscreenRef = useRef(isFullscreen);
  useLayoutEffect(() => {
    const wasFullscreen = wasFullscreenRef.current;
    wasFullscreenRef.current = isFullscreen;
    if (!wasFullscreen || isFullscreen) return;
    requestAnimationFrame(() => {
      relayoutDockviewInstances();
    });
  }, [isFullscreen]);

  useEffect(() => {
    syncEmbeddedWorkspacePanelVisibility(workspace.id);
  }, [workspace.id, isCurrentWorkspacePoppedOut, isFullscreen]);

  const [keepBottomMounted, setKeepBottomMounted] = useState(() => {
    const state = useBottomPanelStore.getState();
    if (state.isFullscreen) return true;
    // 首屏看板：先不挂 dock，等 idle / 打开切换器再预热，避免挡 LCP
    if (typeof window !== "undefined" && isDashboardPath(window.location.pathname)) {
      return false;
    }
    return state.workspaceMode !== "hidden";
  });

  useEffect(() => {
    if (isBottomPanelOpen || isFullscreen || dockWarm) {
      setKeepBottomMounted(true);
    }
    // 首页不再强制卸载：保活 shell，由 contentSuspended 抑制重型 panel
  }, [isBottomPanelOpen, isFullscreen, dockWarm]);

  // 首页空闲预热：提前建好 dockview shell
  useEffect(() => {
    if (!isHomeRoute || isFullscreen || keepBottomMounted) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) {
        requestWorkspaceDockWarmup(workspace.id);
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 1200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(id);
      };
    }
    const timer = window.setTimeout(run, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isHomeRoute, isFullscreen, keepBottomMounted, workspace.id]);

  const rootClass = [
    "workspace-preview",
    isFullscreen ? "workspace-preview--fullscreen" : "",
    isPreviewCollapsed ? "workspace-preview--collapsed" : "",
    isBottomPanelOpen ? `workspace-preview--${displayMode}` : "",
    contentSuspended ? "workspace-preview--content-suspended" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const showBottomStack = keepBottomMounted;
  const dockVisible = (showSplitWindow || isFullscreen) && !isCurrentWorkspacePoppedOut;

  const bottomPanel = showBottomStack ? (
    <div ref={bottomStackRef} className="workspace-preview__bottom-stack">
      <div
        className="workspace-preview__dock"
        data-visible={dockVisible ? "true" : "false"}
        aria-hidden={!dockVisible}
      >
        <WorkspaceBottomHost contentSuspended={contentSuspended} />
      </div>
      {showTaskBar ? (
        <div
          className="workspace-preview__taskbar-slot"
          data-visible="true"
          aria-hidden={false}
        >
          <WorkspacePreviewTaskBar />
        </div>
      ) : null}
    </div>
  ) : (
    <div className="workspace-preview__bottom-stack workspace-preview__bottom-stack--placeholder" />
  );

  return (
    <SidebarBottom
      className={rootClass}
      sidebar={bottomPanel}
      bottomResizeLocked={showTaskBar}
      forceCollapsed={isHomeRoute && !isFullscreen}
      sidebarMinPx={WS_HEIGHT_HIDDEN_MAX + 1}
    >
      <div className="workspace-preview__main">{children}</div>
    </SidebarBottom>
  );
}

/** task-bar 固定高度，供外部样式引用 */
export { WS_HEIGHT_TASKBAR_MAX as WORKSPACE_PREVIEW_TASKBAR_HEIGHT_PX } from "../../../lib/workspaceMode";
