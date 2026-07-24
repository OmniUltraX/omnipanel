/** 全屏工程工作区扣除侧栏与底栏状态条后的可用尺寸（不触碰 DOM 测量）。 */
export const WORKSPACE_FULLSCREEN_STATUSBAR_PX = 26;

export function measureFullscreenWorkspaceDockSize(): { width: number; height: number } {
  const sidebarW =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"),
    ) || 56;
  return {
    width: Math.max(0, window.innerWidth - sidebarW),
    height: Math.max(0, window.innerHeight - WORKSPACE_FULLSCREEN_STATUSBAR_PX),
  };
}
