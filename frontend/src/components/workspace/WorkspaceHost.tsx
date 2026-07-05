import type { ReactNode } from "react";
import { WorkspacePreview } from "../ui/workspace/WorkspacePreview";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { workspaceShellState } from "../../lib/workspaceMode";

interface WorkspaceHostProps {
  children: ReactNode;
}

/**
 * 应用级工作区宿主：嵌入态包 WorkspacePreview；工程工作区全屏时仅渲染主内容。
 * 全屏底栏由 App 层唯一挂载 WorkspaceBottomHost。
 */
export function WorkspaceHost({ children }: WorkspaceHostProps) {
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const isBottomFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const wsState = workspaceShellState(workspaceMode);
  const embeddedModeClass =
    workspaceMode !== "fullscreen" &&
    workspaceMode !== "home" &&
    workspaceMode !== "hidden"
      ? ` workspace-host--${workspaceMode}`
      : "";

  if (isBottomFullscreen) {
    return (
      <div className={`content-bottom workspace-host workspace-host--${wsState}`}>
        {children}
      </div>
    );
  }

  return (
    <WorkspacePreview
      className={`content-bottom workspace-host workspace-host--${wsState}${embeddedModeClass}`}
    >
      {children}
    </WorkspacePreview>
  );
}
