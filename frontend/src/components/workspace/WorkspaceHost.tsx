import { memo, type ReactNode } from "react";
import { WorkspacePreview } from "../ui/workspace/WorkspacePreview";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { workspaceShellState } from "../../lib/workspaceMode";

interface WorkspaceHostProps {
  children: ReactNode;
}

/**
 * 内层：仅渲染 children，不订阅任何状态。
 * memo 包裹确保父组件（WorkspaceShell）重渲染时 children 引用不变则跳过。
 */
const WorkspaceHostInner = memo(function WorkspaceHostInner({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <WorkspacePreview className={className}>{children}</WorkspacePreview>
  );
});

/**
 * 外层：订阅 workspaceMode/isFullscreen 计算 className，
 * 把 children 透传给 memo 内层。全屏切换时只有外层重渲染，
 * 内层因 children 引用不变而跳过，routePanels 子树不参与 reconciliation。
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
    <WorkspaceHostInner
      className={`content-bottom workspace-host workspace-host--${wsState}${embeddedModeClass}`}
    >
      {children}
    </WorkspaceHostInner>
  );
}
