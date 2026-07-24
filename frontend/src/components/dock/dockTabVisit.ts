/**
 * Dock Tab 内容挂载判定：未访问不挂、访问后 sticky、模块挂起时全挂起。
 * 与工程工作区 contentSuspended 语义对齐。
 */
export function shouldMountDockTabContent(options: {
  active: boolean;
  visited: boolean;
  contentSuspended?: boolean;
}): boolean {
  if (options.contentSuspended) return false;
  return options.active || options.visited;
}

/** 将 tabId 加入 visited（不可变 Set，便于 React state） */
export function markDockTabVisited(
  prev: ReadonlySet<string>,
  tabId: string | null | undefined,
): Set<string> {
  if (!tabId) return prev instanceof Set ? prev : new Set(prev);
  if (prev.has(tabId)) {
    return prev instanceof Set ? prev : new Set(prev);
  }
  const next = new Set(prev);
  next.add(tabId);
  return next;
}

export function createInitialDockTabVisited(
  activeTabId: string | null | undefined,
): Set<string> {
  return activeTabId ? new Set([activeTabId]) : new Set();
}
