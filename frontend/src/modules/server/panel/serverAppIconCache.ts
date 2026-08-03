/**
 * 应用市场图标会话级缓存（进程内常驻）。
 * 避免切换 Tab / 卸载 ServerAppsTab 后重复经后端拉 data URL。
 */

type ServerIconBucket = {
  icons: Map<string, string>;
  broken: Set<string>;
};

const buckets = new Map<string, ServerIconBucket>();

function bucket(serverId: string): ServerIconBucket {
  let entry = buckets.get(serverId);
  if (!entry) {
    entry = { icons: new Map(), broken: new Set() };
    buckets.set(serverId, entry);
  }
  return entry;
}

/** 读取某面板已缓存的图标 data URL。 */
export function getServerAppIcon(serverId: string, appKey: string): string | undefined {
  if (!serverId || !appKey) return undefined;
  return buckets.get(serverId)?.icons.get(appKey);
}

/** 写入图标 data URL。 */
export function setServerAppIcon(serverId: string, appKey: string, dataUrl: string): void {
  if (!serverId || !appKey || !dataUrl) return;
  const b = bucket(serverId);
  b.icons.set(appKey, dataUrl);
  b.broken.delete(appKey);
}

/** 标记拉取失败，避免反复打接口。 */
export function markServerAppIconBroken(serverId: string, appKey: string): void {
  if (!serverId || !appKey) return;
  const b = bucket(serverId);
  b.broken.add(appKey);
}

export function isServerAppIconBroken(serverId: string, appKey: string): boolean {
  if (!serverId || !appKey) return false;
  return Boolean(buckets.get(serverId)?.broken.has(appKey));
}

/** 供组件挂载时一次性回填本地 state。 */
export function peekServerAppIconCache(serverId: string): {
  icons: Record<string, string>;
  broken: ReadonlySet<string>;
} {
  const entry = buckets.get(serverId);
  if (!entry) {
    return { icons: {}, broken: new Set() };
  }
  return {
    icons: Object.fromEntries(entry.icons),
    broken: new Set(entry.broken),
  };
}

/** 批量写入成功图标。 */
export function setServerAppIcons(
  serverId: string,
  icons: Record<string, string>,
): void {
  if (!serverId) return;
  const b = bucket(serverId);
  for (const [key, url] of Object.entries(icons)) {
    if (!key || !url) continue;
    b.icons.set(key, url);
    b.broken.delete(key);
  }
}

/** 批量标记失败。 */
export function markServerAppIconsBroken(serverId: string, keys: Iterable<string>): void {
  if (!serverId) return;
  const b = bucket(serverId);
  for (const key of keys) {
    if (key) b.broken.add(key);
  }
}
