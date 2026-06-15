import { createPortal } from "react-dom";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { WorkspaceBottomHost } from "./WorkspaceBottomHost";
import { WorkspaceBottomTitleBar } from "./WorkspaceBottomTitleBar";

/** App.tsx 中 `#workspace-bottom-fullscreen-root` 的 id */
export const WORKSPACE_BOTTOM_FULLSCREEN_ROOT_ID = "workspace-bottom-fullscreen-root";

interface WorkspaceBottomShellProps {}

/**
 * 底部工程工作区外壳：标题栏 + dockview 容器。
 * 全屏时将同一实例 portal 到 workspace 级 overlay，避免挤压 dock 标签栏。
 */
export function WorkspaceBottomShell(_props: WorkspaceBottomShellProps) {
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);

  const shell = (
    <div className="workspace-bottom-shell">
      <WorkspaceBottomTitleBar showWinControls={isFullscreen} />
      <WorkspaceBottomHost />
    </div>
  );

  const portalRoot =
    typeof document !== "undefined"
      ? document.getElementById(WORKSPACE_BOTTOM_FULLSCREEN_ROOT_ID)
      : null;

  if (isFullscreen && portalRoot) {
    return (
      <>
        {createPortal(shell, portalRoot)}
        <div className="workspace-bottom-shell-placeholder" aria-hidden />
      </>
    );
  }

  return shell;
}
