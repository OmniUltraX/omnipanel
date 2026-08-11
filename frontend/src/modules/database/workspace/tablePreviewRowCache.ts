/**
 * 表预览行缓存（React 外）。
 *
 * 加载时把 rows 写进这里并 notify，Canvas 只 invalidate 重绘，
 * 不触发 TableDataGrid 整树 reconcile——这才是侧栏加载期仍跟手的关键。
 */

export type TablePreviewCachedRows = Record<string, unknown>[];

type CacheEntry = {
  rows: TablePreviewCachedRows;
  columns: string[];
  name: string;
};

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();

function notify(tabId: string) {
  const set = listeners.get(tabId);
  if (!set) return;
  for (const listener of set) {
    listener();
  }
}

export function getTablePreviewRowCache(tabId: string): CacheEntry | undefined {
  return cache.get(tabId);
}

export function setTablePreviewRowCache(
  tabId: string,
  entry: CacheEntry | null,
): void {
  if (!entry || entry.rows.length === 0) {
    if (cache.delete(tabId)) {
      notify(tabId);
    }
    return;
  }
  cache.set(tabId, entry);
  notify(tabId);
}

/** 分片灌入：只换 rows 引用，columns/name 保持 */
export function patchTablePreviewRowCacheRows(
  tabId: string,
  rows: TablePreviewCachedRows,
  meta: { name: string; columns: string[] },
): void {
  cache.set(tabId, {
    name: meta.name,
    columns: meta.columns,
    rows,
  });
  notify(tabId);
}

export function clearTablePreviewRowCache(tabId: string): void {
  if (cache.delete(tabId)) {
    notify(tabId);
  }
}

/**
 * 硬重置（换表 / beginFetch）：写入空 cache 并 notify。
 * 与 clear（删除条目）不同——订阅方会 apply 空行，而不会回退到仍可能滞后的 displayRows（#44）。
 */
export function resetTablePreviewRowCache(tabId: string): void {
  cache.set(tabId, { rows: [], columns: [], name: "" });
  notify(tabId);
}

export function subscribeTablePreviewRowCache(
  tabId: string,
  listener: () => void,
): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      listeners.delete(tabId);
    }
  };
}
