export type CachedPathEntry = { name: string; isDir: boolean };

type CacheEntry = {
  entries: CachedPathEntry[];
  fetchedAt: number;
};

/** 同一目录短时间内不重复 IPC；前缀变化只做本地过滤 */
const TTL_MS = 8_000;
const MAX_ENTRIES = 48;

const cache = new Map<string, CacheEntry>();

export function pathListingCacheKey(
  sessionType: string,
  resourceId: string | null | undefined,
  dir: string,
): string {
  return `${sessionType}:${resourceId ?? "local"}:${dir}`;
}

export function getCachedPathListing(key: string): CachedPathEntry[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  return hit.entries;
}

export function isPathListingStale(key: string): boolean {
  const hit = cache.get(key);
  if (!hit) return true;
  return Date.now() - hit.fetchedAt > TTL_MS;
}

export function setCachedPathListing(key: string, entries: CachedPathEntry[]): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { entries, fetchedAt: Date.now() });
}

export function invalidatePathListingCache(): void {
  cache.clear();
}
