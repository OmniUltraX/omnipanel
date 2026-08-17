import { relayoutDockviewInstances } from "./dockviewRegistry";

/** 重置自定义标题栏 dock 的滚动偏移（scrollIntoView / focus 可能把 tab 栏滚出视口）。 */
export function resetDockWindowControlScroll(): void {
  if (typeof document === "undefined") return;
  for (const root of document.querySelectorAll<HTMLElement>(
    ".dockable-workspace.dock-window-control",
  )) {
    if (root.scrollTop !== 0) root.scrollTop = 0;
    if (root.scrollLeft !== 0) root.scrollLeft = 0;
    for (const el of root.querySelectorAll<HTMLElement>(
      ".dv-shell, .dockable-workspace__dockview, .dv-groupview",
    )) {
      if (el.scrollTop !== 0) el.scrollTop = 0;
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
    }
  }
}

/**
 * SQL 编辑器排版（字体/行高）变更后：恢复 windowControl 标题栏布局。
 * 设置页改值与编辑器 theme reconfigure 都会触发。
 */
export function restoreDockWindowChromeAfterLayout(scopePrefix?: string): void {
  queueMicrotask(() => {
    requestAnimationFrame(() => {
      resetDockWindowControlScroll();
      relayoutDockviewInstances(scopePrefix);
    });
  });
}
