import { useEffect, useRef } from "react";
import { relayoutDockviewInstances } from "../../lib/dockviewRegistry";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspaceWindowStore } from "../../stores/workspaceWindowStore";
import { WorkspacePanel } from "./WorkspacePanel";

const WORKSPACE_FULLSCREEN_STATUSBAR_PX = 26;

function measureWorkspaceBottomHostSize(isFullscreen: boolean): { width: number; height: number } {
  if (isFullscreen) {
    const sidebarW = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"),
    ) || 56;
    return {
      width: Math.max(0, window.innerWidth - sidebarW),
      height: Math.max(0, window.innerHeight - WORKSPACE_FULLSCREEN_STATUSBAR_PX),
    };
  }
  return { width: 0, height: 0 };
}

function workspaceDockScope(workspaceId: string): string {
  return `workspace-bottom-${workspaceId}`;
}

/**
 * 工作区容器：仅挂载当前活动工作区的 dockview，切换时卸载其余实例。
 */
export function WorkspaceBottomHost() {
  const hostRef = useRef<HTMLDivElement>(null);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const poppedOutIds = useWorkspaceWindowStore((state) => state.poppedOutIds);
  const renderWorkspaces = workspaces.filter((ws) => !poppedOutIds.includes(ws.id));
  const activeHostId =
    isFullscreen && renderWorkspaces.length > 0
      ? (renderWorkspaces.find((ws) => ws.id === currentId)?.id ??
          renderWorkspaces[0]?.id)
      : currentId;
  const activeWorkspace = renderWorkspaces.find((ws) => ws.id === activeHostId);

  useEffect(() => {
    if (isFullscreen) return;
    const el = hostRef.current;
    if (!el) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const { width, height } = rect;
      if (width <= 0 || height <= 0) return;
      if (Math.abs(width - lastWidth) < 1 && Math.abs(height - lastHeight) < 1) {
        return;
      }
      lastWidth = width;
      lastHeight = height;
      requestAnimationFrame(() => {
        relayoutDockviewInstances(workspaceDockScope(activeHostId), { width, height });
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isFullscreen, activeHostId]);

  useEffect(() => {
    if (!isFullscreen) return;
    const relayout = () => {
      const { width, height } = measureWorkspaceBottomHostSize(true);
      if (width > 0 && height > 0) {
        relayoutDockviewInstances(workspaceDockScope(activeHostId), { width, height });
      }
    };
    window.addEventListener("resize", relayout);
    return () => window.removeEventListener("resize", relayout);
  }, [isFullscreen, activeHostId]);

  useEffect(() => {
    if (!activeWorkspace) return;
    const scope = workspaceDockScope(activeHostId);
    // 双 rAF（约 32ms）替代 setTimeout(50ms)：等布局稳定后 relayout，
    // 但比 50ms 更快，减少全屏切换时的布局空白感知。
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (isFullscreen) {
          const { width, height } = measureWorkspaceBottomHostSize(true);
          if (width > 0 && height > 0) {
            relayoutDockviewInstances(scope, { width, height });
          }
          return;
        }
        if (!hostRef.current) return;
        const rect = hostRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          relayoutDockviewInstances(scope, { width: rect.width, height: rect.height });
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [activeHostId, activeWorkspace, isFullscreen]);

  if (!activeWorkspace) {
    return (
      <div
        ref={hostRef}
        className="workspace-bottom-host"
        style={{ position: "relative", width: "100%", height: "100%" }}
      />
    );
  }

  return (
    <div
      ref={hostRef}
      className="workspace-bottom-host"
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <div
        key={activeWorkspace.id}
        data-workspace-id={activeWorkspace.id}
        className="workspace-bottom-host-panel"
        style={{ width: "100%", height: "100%", position: "relative" }}
      >
        <WorkspacePanel workspace={activeWorkspace} />
      </div>
    </div>
  );
}
