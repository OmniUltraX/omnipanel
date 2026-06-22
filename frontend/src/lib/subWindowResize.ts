/** SubWindow 几何变化时定向通知，避免全局 window resize 触发所有 xterm fit。 */

export const SUBWINDOW_RESIZE_EVENT = "omnipanel:subwindow-resize";

export interface SubWindowResizeDetail {
  subWindowId: string;
}

export function dispatchSubWindowResize(subWindowId: string) {
  window.dispatchEvent(
    new CustomEvent<SubWindowResizeDetail>(SUBWINDOW_RESIZE_EVENT, {
      detail: { subWindowId },
    }),
  );
}

let globalResizeTimer: ReturnType<typeof setTimeout> | null = null;

/** 视口尺寸变化时的 debounced 全局 resize（SubWindow 最大化等场景）。 */
export function dispatchDebouncedWindowResize(delayMs = 120) {
  if (globalResizeTimer) {
    clearTimeout(globalResizeTimer);
  }
  globalResizeTimer = setTimeout(() => {
    globalResizeTimer = null;
    window.dispatchEvent(new Event("resize"));
  }, delayMs);
}
