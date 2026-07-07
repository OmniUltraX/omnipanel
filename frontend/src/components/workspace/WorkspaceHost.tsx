import type { ReactNode } from "react";
import { WorkspacePreview } from "../ui/workspace/WorkspacePreview";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { workspaceShellState } from "../../lib/workspaceMode";

interface WorkspaceHostProps {
  children: ReactNode;
}

/**
 * 始终返回 WorkspacePreview，避免全屏切换时 return type 变化
 * 导致 routePanels 子树 unmount/remount。
 */
export function WorkspaceHost({ children }: WorkspaceHostProps) {
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const isBottomFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const wsState = workspaceShellState(workspaceMode);
  const embeddedModeClass =
    !isBottomFullscreen &&
    workspaceMode !== "fullscreen" &&
    workspaceMode !== "home" &&
    workspaceMode !== "hidden"
      ? ` workspace-host--${workspaceMode}`
      : "";

  return (
    <WorkspacePreview
      className={`content-bottom workspace-host workspace-host--${wsState}${embeddedModeClass}`}
    >
      {children}
    </WorkspacePreview>
  );
}
