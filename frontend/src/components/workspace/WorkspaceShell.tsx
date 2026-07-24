import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspaceWindowStore } from "../../stores/workspaceWindowStore";
import { workspaceShellState } from "../../lib/workspaceMode";
import {
  isOverlayModulePath,
  isShellRoutePath,
} from "../../lib/routePanels";
import {
  WORKSPACE_PATHS,
  isWorkspacePath,
} from "../../lib/paths";
import { Topbar } from "../shell/Topbar";
import { StatusBar } from "../shell/StatusBar";
import { WorkspaceHost } from "./WorkspaceHost";
import { AiDockView } from "../ai/AiDockView";
import { AiDockviewResizeHandle } from "../ai/AiDockviewResizeHandle";

interface WorkspaceShellProps {
  title: string;
  routePanels: ReactNode;
  dockWidth: string;
  dockOpen: boolean;
  aiDockview: boolean;
  topbarActions: ReactNode;
}

/**
 * .workspace 容器：隔离 bottomPanelStore 订阅，避免全屏切换时 App 整体重渲染。
 * 全屏 mode/isFullscreen 变化只触发本组件重渲染，routePanels 引用不变。
 */
export const WorkspaceShell = memo(function WorkspaceShell({
  title,
  routePanels,
  dockWidth,
  dockOpen,
  aiDockview,
  topbarActions,
}: WorkspaceShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceMode = useBottomPanelStore((s) => s.workspaceMode);
  const isBottomFullscreen = useBottomPanelStore((s) => s.isFullscreen);
  const deferExitPath = useBottomPanelStore((s) => s.deferExitFullscreenUntilPath);
  const workspaceId = useWorkspaceStore((s) => s.workspace.id);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const poppedOutIds = useWorkspaceWindowStore((s) => s.poppedOutIds);
  const hasHostedWorkspace = workspaces.some((ws) => !poppedOutIds.includes(ws.id));
  const isCurrentWorkspacePoppedOut = poppedOutIds.includes(workspaceId);
  const hideMainEmbeddedWorkspace =
    isCurrentWorkspacePoppedOut && !(isBottomFullscreen && hasHostedWorkspace);
  const wsState = hideMainEmbeddedWorkspace
    ? "off"
    : workspaceShellState(workspaceMode);
  const showBottomFullscreen = isBottomFullscreen && !hideMainEmbeddedWorkspace;
  const embeddedModeClass =
    !hideMainEmbeddedWorkspace &&
    workspaceMode !== "fullscreen" &&
    workspaceMode !== "hidden"
      ? ` workspace--mode-${workspaceMode}`
      : "";
  const workspaceRef = useRef<HTMLDivElement>(null);

  // 全屏延迟退出：路由 commit 后同一 layout 阶段再解除全屏，避免闪旧页面
  useLayoutEffect(() => {
    useBottomPanelStore.getState().tryCompleteDeferExitFullscreen(location.pathname);
  }, [location.pathname, deferExitPath]);

  // 工程工作区全屏时同步 URL 到 /workspace/:id
  useEffect(() => {
    if (workspaceMode !== "fullscreen" && workspaceMode !== "home") return;
    if (hideMainEmbeddedWorkspace) return;
    if (isWorkspacePath(location.pathname)) return;
    if (isShellRoutePath(location.pathname) || isOverlayModulePath(location.pathname)) {
      return;
    }
    const id = useWorkspaceStore.getState().workspace.id;
    navigate(WORKSPACE_PATHS.detail(id), { replace: true });
  }, [workspaceMode, location.pathname, navigate, hideMainEmbeddedWorkspace]);

  return (
    <div
      ref={workspaceRef}
      className={`workspace workspace--${wsState}${showBottomFullscreen ? " workspace--bottom-fullscreen" : ""}${embeddedModeClass}`}
      style={{ "--ai-dock-w": dockWidth } as React.CSSProperties}
    >
      <Topbar title={title} hidden>
        {topbarActions}
      </Topbar>
      <div className="workspace-body">
        <div className={`content-area ws-state-${wsState}`}>
          <WorkspaceHost>{routePanels}</WorkspaceHost>
        </div>
        {dockOpen ? (
          <AiDockviewResizeHandle workspaceRef={workspaceRef} />
        ) : null}
        {aiDockview ? <AiDockView /> : null}
      </div>
      <StatusBar />
    </div>
  );
});
