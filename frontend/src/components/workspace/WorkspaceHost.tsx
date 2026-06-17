import type { ReactNode } from "react";
import { SidebarBottom } from "../ui/SidebarBottom";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { WorkspaceBottomShell } from "./WorkspaceBottomShell";

interface WorkspaceHostProps {
  children: ReactNode;
}

/**
 * 应用级工作区宿主：统一 full / half / off 三种嵌入状态。
 * - full + 首页：HomeWorkspacePanel（固定看板 / AI Tab）
 * - full + 工程工作区：WorkspacePanel 全屏
 * - half：上方功能页 + 下方工程工作区
 * - off：仅功能页
 */
export function WorkspaceHost({ children }: WorkspaceHostProps) {
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const isHomeActive = useBottomPanelStore((state) => state.isHomeActive);
  const isOpen = useBottomPanelStore((state) => state.isOpen);
  const wsState = isFullscreen ? "full" : isOpen ? "half" : "off";

  return (
    <SidebarBottom
      className={`content-bottom workspace-host workspace-host--${wsState}${isHomeActive ? " workspace-host--home" : ""}`}
      sidebar={<WorkspaceBottomShell />}
    >
      {children}
    </SidebarBottom>
  );
}
