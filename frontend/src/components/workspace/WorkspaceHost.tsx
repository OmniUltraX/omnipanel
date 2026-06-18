import type { ReactNode } from "react";
import { SidebarBottom } from "../ui/SidebarBottom";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { workspaceShellState } from "../../lib/workspaceMode";
import { WorkspaceBottomShell } from "./WorkspaceBottomShell";

interface WorkspaceHostProps {
  children: ReactNode;
}

/**
 * 应用级工作区宿主：统一 full / half / off 及嵌入子形态。
 */
export function WorkspaceHost({ children }: WorkspaceHostProps) {
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const isHomeActive = useBottomPanelStore((state) => state.isHomeActive);
  const wsState = workspaceShellState(workspaceMode);

  return (
    <SidebarBottom
      className={`content-bottom workspace-host workspace-host--${wsState}${isHomeActive ? " workspace-host--home" : ""}${workspaceMode !== "fullscreen" && workspaceMode !== "home" && workspaceMode !== "hidden" ? ` workspace-host--${workspaceMode}` : ""}`}
      sidebar={<WorkspaceBottomShell />}
    >
      {children}
    </SidebarBottom>
  );
}
