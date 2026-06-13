import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { WorkspaceBottomHost } from "./WorkspaceBottomHost";
import { WorkspaceBottomTitleBar } from "./WorkspaceBottomTitleBar";

interface WorkspaceBottomShellProps {}

/**
 * 底部工程工作区外壳：标题栏 + 多工作区 dockview 容器。
 */
export function WorkspaceBottomShell(_props: WorkspaceBottomShellProps) {
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);

  return (
    <div className="workspace-bottom-shell">
      <WorkspaceBottomTitleBar showWinControls={isFullscreen} />
      <WorkspaceBottomHost />
    </div>
  );
}
