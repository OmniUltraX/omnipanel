import { useEffect, useRef } from "react";
import { relayoutDockviewInstances } from "../../lib/dockviewRegistry";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
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

/**
 * 工作区容器：按当前工作区挂载 dockview 面板。
 */
export function WorkspaceBottomHost() {
  const hostRef = useRef<HTMLDivElement>(null);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver((entries) => {
      if (useBottomPanelStore.getState().isFullscreen) return;
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
        relayoutDockviewInstances("workspace-bottom", { width, height });
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentId]);

  useEffect(() => {
    if (!isFullscreen) return;
    const relayout = () => {
      const { width, height } = measureWorkspaceBottomHostSize(true);
      if (width > 0 && height > 0) {
        relayoutDockviewInstances("workspace-bottom", { width, height });
      }
    };
    relayout();
    window.addEventListener("resize", relayout);
    return () => window.removeEventListener("resize", relayout);
  }, [isFullscreen, currentId]);

  // 当工作区切换时，手动触发一次 relayout，确保 display:block 后正确计算尺寸
  useEffect(() => {
    if (isFullscreen) return;
    if (hostRef.current) {
      const rect = hostRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        requestAnimationFrame(() => {
          relayoutDockviewInstances("workspace-bottom", { width: rect.width, height: rect.height });
        });
      }
    }
  }, [currentId, isFullscreen]);

  return (
    <div ref={hostRef} className="workspace-bottom-host" style={{ position: "relative", width: "100%", height: "100%" }}>
      {workspaces.map((ws) => (
        <div
          key={ws.id}
          style={{
            display: ws.id === currentId ? "block" : "none",
            width: "100%",
            height: "100%",
            position: "absolute",
            top: 0,
            left: 0,
          }}
        >
          <WorkspacePanel workspace={ws} />
        </div>
      ))}
    </div>
  );
}
