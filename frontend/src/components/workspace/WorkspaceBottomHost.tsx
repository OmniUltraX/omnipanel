import { useEffect, useRef } from "react";
import { relayoutDockviewInstances } from "../../lib/dockviewRegistry";
import { measureFullscreenWorkspaceDockSize } from "../../lib/workspaceDockMeasure";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useWorkspaceDockWarmupStore } from "../../stores/workspaceDockWarmupStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspaceWindowStore } from "../../stores/workspaceWindowStore";
import { WorkspacePanel } from "./WorkspacePanel";

function workspaceDockScope(workspaceId: string): string {
  return `workspace-bottom-${workspaceId}`;
}

interface WorkspaceBottomHostProps {
  /**
   * 首页预热：挂载 dockview shell，但不渲染 panel 业务内容
   * （避免 Schema / 表格虚拟列表在看板空跑）。
   */
  contentSuspended?: boolean;
}

/**
 * 工作区容器：仅挂载当前活动工作区的 dockview，切换时卸载其余实例。
 * 全屏 resize relayout 由 WorkspacePreview 统一负责，此处只处理：
 * - 非全屏 ResizeObserver
 * - 切换 activeHost 后补一次 layout
 */
export function WorkspaceBottomHost({ contentSuspended = false }: WorkspaceBottomHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const warmTargetId = useWorkspaceDockWarmupStore((state) => state.targetWorkspaceId);
  const poppedOutIds = useWorkspaceWindowStore((state) => state.poppedOutIds);
  const renderWorkspaces = workspaces.filter((ws) => !poppedOutIds.includes(ws.id));

  // 预热阶段优先挂载 hover/指针指向的工作区，减少选中后 remount
  const preferredId =
    contentSuspended && warmTargetId && renderWorkspaces.some((ws) => ws.id === warmTargetId)
      ? warmTargetId
      : currentId;

  const activeHostId =
    isFullscreen && renderWorkspaces.length > 0
      ? (renderWorkspaces.find((ws) => ws.id === preferredId)?.id ??
          renderWorkspaces[0]?.id)
      : preferredId;
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

  // 切换工作区 / 首次挂载后补一次 layout（全屏尺寸由 measure 计算，不走 getBoundingClientRect）
  useEffect(() => {
    if (!activeWorkspace || contentSuspended) return;
    const scope = workspaceDockScope(activeHostId);
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (isFullscreen) {
          const { width, height } = measureFullscreenWorkspaceDockSize();
          if (width > 0 && height > 0) {
            relayoutDockviewInstances(scope, { width, height });
          }
          return;
        }
        if (!hostRef.current) return;
        const { width, height } = hostRef.current.getBoundingClientRect();
        if (width > 0 && height > 0) {
          relayoutDockviewInstances(scope, { width, height });
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [activeHostId, activeWorkspace, isFullscreen, contentSuspended]);

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
        <WorkspacePanel
          workspace={activeWorkspace}
          contentSuspended={contentSuspended}
        />
      </div>
    </div>
  );
}
