/**
 * Dock Tab 内容挂载判定：未访问不挂、访问后 sticky、模块挂起时按策略处理。
 * 与工程工作区 contentSuspended 语义对齐。
 */

/** 数据库等工作区 sticky 保活上限（含当前激活 / 分屏可见）；超出按 LRU 卸内容。 */
export const DEFAULT_STICKY_VISIT_MAX = 5;

export function shouldMountDockTabContent(options: {
  active: boolean;
  visited: boolean;
  contentSuspended?: boolean;
  /**
   * 为 true 时：挂起仍保留已访问 Tab（模块切走再切回不 remount）。
   * 为 false / 缺省：挂起一律不挂（首页预热 / 工程工作区抑制重活）。
   */
  keepVisitedWhileSuspended?: boolean;
}): boolean {
  if (options.contentSuspended) {
    return Boolean(options.keepVisitedWhileSuspended && options.visited);
  }
  return options.active || options.visited;
}

/** 将 tabId 标为最近访问（MRU 序：旧 → 新）；已存在则移到末尾。 */
export function markDockTabVisitedMru(
  prev: readonly string[],
  tabId: string | null | undefined,
): string[] {
  if (!tabId) return prev.slice();
  if (prev.length === 1 && prev[0] === tabId) return prev as string[];
  if (prev[prev.length - 1] === tabId) return prev as string[];
  const next = prev.filter((id) => id !== tabId);
  next.push(tabId);
  return next;
}

/**
 * 按 LRU 裁剪访问列表：始终保留 protect 中的 id，其余按最近访问保留至 max。
 * protect 可超过 max（分屏多可见时以可见为准）。
 */
export function trimDockTabVisitedMru(
  order: readonly string[],
  options: { max: number; protect?: ReadonlySet<string> | Iterable<string> },
): string[] {
  const max = Math.max(0, options.max);
  const protect = new Set(
    options.protect
      ? [...options.protect].map((id) => String(id).trim()).filter(Boolean)
      : [],
  );
  if (order.length === 0 && protect.size === 0) return [];

  const kept = new Set<string>();
  for (const id of protect) kept.add(id);

  // 从最近到最旧补齐
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (kept.size >= Math.max(max, protect.size)) break;
    kept.add(order[i]!);
  }

  // 保活 protect 即便不在 order 里（刚激活）
  const result = order.filter((id) => kept.has(id));
  for (const id of protect) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

/** @deprecated 使用 markDockTabVisitedMru；保留 Set 形态兼容旧测试调用 */
export function markDockTabVisited(
  prev: ReadonlySet<string>,
  tabId: string | null | undefined,
): Set<string> {
  if (!tabId) return prev instanceof Set ? prev : new Set(prev);
  const order = markDockTabVisitedMru([...prev], tabId);
  if (order.length === prev.size && prev.has(tabId)) {
    return prev instanceof Set ? prev : new Set(prev);
  }
  return new Set(order);
}

export function createInitialDockTabVisited(
  activeTabId: string | null | undefined,
): Set<string> {
  return activeTabId ? new Set([activeTabId]) : new Set();
}

export function createInitialDockTabVisitedOrder(
  activeTabId: string | null | undefined,
): string[] {
  return activeTabId ? [activeTabId] : [];
}
