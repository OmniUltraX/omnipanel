import { useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { WorkspacePreview } from "../ui/WorkspacePreview";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { workspaceShellState } from "../../lib/workspaceMode";
import { isWorkspacePath } from "../../lib/paths";

interface WorkspaceHostProps {
  children: ReactNode;
}

/**
 * 应用级工作区宿主：统一 full / half / off 及嵌入子形态。
 * 工作区详情路由（/workspace/:id）下不渲染底部预览栏。
 */
export function WorkspaceHost({ children }: WorkspaceHostProps) {
  const location = useLocation();
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const isHomeActive = useBottomPanelStore((state) => state.isHomeActive);
  const wsState = workspaceShellState(workspaceMode);
  const inWorkspaceDetail = isWorkspacePath(location.pathname);

  if (inWorkspaceDetail) {
    return (
      <div className={`content-bottom workspace-host workspace-host--${wsState}${isHomeActive ? " workspace-host--home" : ""}`}>
        {children}
      </div>
    );
  }

  return (
    <WorkspacePreview
      className={`content-bottom workspace-host workspace-host--${wsState}${isHomeActive ? " workspace-host--home" : ""}${workspaceMode !== "fullscreen" && workspaceMode !== "home" && workspaceMode !== "hidden" ? ` workspace-host--${workspaceMode}` : ""}`}
    >
      {children}
    </WorkspacePreview>
  );
}
