import type { NavigateFunction } from "react-router-dom";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** 进入全屏工作区（Home） */
export function goWorkspaceHome(): void {
  useBottomPanelStore.getState().enterHomeWorkspace();
}

/** 从全屏工作区离开并恢复上次记住的 off/half 嵌入状态 */
export function leaveWorkspaceHomeForFeature(): void {
  useBottomPanelStore.getState().leaveHomeToFeature();
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
