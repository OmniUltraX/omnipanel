import { useEffect, useRef } from "react";
import { isServerPanelCacheStale } from "./serverPanelCache";
import type { ServerEntry } from "./serverConnection";

type Options = {
  server: ServerEntry | null;
  /** websites/certificates 用 refreshedAt；应用市场用 appsRefreshedAt */
  refreshedAt: number | null;
  refreshing: boolean;
  refresh: (server: ServerEntry) => Promise<unknown>;
  enabled?: boolean;
};

/**
 * 面板资源缓存自动回源：
 * - 无缓存 → 立即拉取
 * - 有缓存但过期 → 打开/挂载时软刷新（有数据时不挡 UI）
 * 同一 server + refreshedAt 只尝试一次，避免失败后死循环。
 */
export function useServerPanelCacheAutoRefresh({
  server,
  refreshedAt,
  refreshing,
  refresh,
  enabled = true,
}: Options): void {
  const attemptKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !server) return;
    if (refreshing) return;
    if (!isServerPanelCacheStale(refreshedAt)) return;

    const key = `${server.id}:${refreshedAt ?? "none"}`;
    if (attemptKeyRef.current === key) return;
    attemptKeyRef.current = key;
    void refresh(server);
  }, [enabled, refresh, refreshedAt, refreshing, server]);
}
