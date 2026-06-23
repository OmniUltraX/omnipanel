import type { NavigateFunction } from "react-router-dom";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { DEFAULT_WORKSPACE, useWorkspaceStore } from "../stores/workspaceStore";
import { DASHBOARD_PATH, WORKSPACE_PATHS, isWorkspacePath } from "./paths";

let chromeIconTransition = false;

function dispatchNavigate(path: string, navigate?: NavigateFunction): void {
  if (navigate) {
    if (!isWorkspacePath(path)) {
      useWorkspaceStore.getState().setActivePath(path);
    }
    navigate(path, { replace: true });
    return;
  }
  window.dispatchEvent(
    new CustomEvent("omnipanel-navigate", {
      detail: { path },
    }),
  );
}

/** 嵌入态：仅切换工程工作区，不跳路由 */
export function switchEmbeddedWorkspace(id: string): void {
  useWorkspaceStore.getState().switchWorkspace(id);
}

/** 进入工程工作区全屏（/workspace/:id） */
export function enterEngineeringWorkspaceFullscreen(
  id: string,
  navigate?: NavigateFunction,
): void {
  useWorkspaceStore.getState().switchWorkspace(id);
  useBottomPanelStore.getState().enterWorkspaceFullscreen();
  const path = WORKSPACE_PATHS.detail(id);
  dispatchNavigate(path, navigate);
}

/** 退出工程工作区全屏，恢复嵌入态并回到功能页或看板 */
export function exitEngineeringWorkspaceFullscreen(
  navigate?: NavigateFunction,
): void {
  const bottom = useBottomPanelStore.getState();
  if (!bottom.isFullscreen) return;
  bottom.exitFullscreen();
  const activePath = useWorkspaceStore.getState().activePath;
  const target = isWorkspacePath(activePath) ? DASHBOARD_PATH : activePath;
  dispatchNavigate(target, navigate);
}

/** 进入看板首页（/dashboard） */
export function goWorkspaceHome(navigate?: NavigateFunction): void {
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen) {
    bottom.leaveFullscreenForFeature();
  }
  useWorkspaceStore.getState().switchWorkspace(DEFAULT_WORKSPACE.id);
  dispatchNavigate(DASHBOARD_PATH, navigate);
}

/** 左上角侧边栏 Logo：非全屏进工程工作区全屏，全屏回首页 */
export function toggleWorkspaceFromChromeIcon(navigate?: NavigateFunction): void {
  if (chromeIconTransition) return;
  chromeIconTransition = true;
  try {
    const bottom = useBottomPanelStore.getState();
    if (bottom.isFullscreen) {
      goWorkspaceHome(navigate);
      return;
    }
    const id = useWorkspaceStore.getState().workspace.id;
    enterEngineeringWorkspaceFullscreen(id, navigate);
  } finally {
    queueMicrotask(() => {
      chromeIconTransition = false;
    });
  }
}

/** 主内容区切换工程工作区：进入全屏路由 */
export function navigateToWorkspace(
  id: string,
  navigate?: NavigateFunction,
): void {
  enterEngineeringWorkspaceFullscreen(id, navigate);
}

/** 工程工作区面板全屏按钮：全屏 ↔ 嵌入态 */
export function toggleEngineeringWorkspaceFullscreen(
  navigate?: NavigateFunction,
): void {
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen) {
    exitEngineeringWorkspaceFullscreen(navigate);
    return;
  }
  const id = useWorkspaceStore.getState().workspace.id;
  enterEngineeringWorkspaceFullscreen(id, navigate);
}

/** 从全屏工作区离开并恢复上次记住的非全屏嵌入形态 */
export function leaveWorkspaceHomeForFeature(): void {
  useBottomPanelStore.getState().leaveFullscreenForFeature();
}

/** 侧边栏 / 命令面板：导航到功能模块，全屏时按记忆状态恢复底部工作区 */
export function navigateToFeature(path: string, navigate: NavigateFunction): void {
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen) {
    bottom.leaveFullscreenForFeature();
  }
  useWorkspaceStore.getState().setActivePath(path);
  navigate(path);
}
