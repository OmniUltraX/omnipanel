import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { WorkspaceBottomHost } from "./WorkspaceBottomHost";

/** 底部 / 全屏工作区外壳（Tab 顶栏由 dockview 承载，无独立标题栏） */
export function WorkspaceBottomShell() {
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);

  if (isFullscreen) {
    return <div className="workspace-bottom-shell-placeholder" aria-hidden />;
  }

  return (
    <div className="workspace-bottom-shell">
      <WorkspaceBottomHost />
    </div>
  );
}
