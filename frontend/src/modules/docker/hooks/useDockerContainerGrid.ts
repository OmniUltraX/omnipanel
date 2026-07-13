import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import { pickStats, statsMapFromList } from "../dockerContainerStatsMatch";
import {
  debugDockerStats,
  debugDockerStatsIpc,
  summarizeStatsList,
} from "../dockerStatsDebug";

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export type DockerContainerGridItem = {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
};

export type UseDockerContainerGridOptions = {
  statsPollMs?: number;
  containersPollMs?: number;
  debugLabel?: string;
};

const DEFAULT_STATS_POLL_MS = 2000;

export function useDockerContainerGrid(
  connectionId: string | null,
  enabled: boolean,
  options?: UseDockerContainerGridOptions,
) {
  const statsPollMs = options?.statsPollMs ?? DEFAULT_STATS_POLL_MS;
  const containersPollMs = options?.containersPollMs ?? statsPollMs;
  const debugLabel = options?.debugLabel;

  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [statsById, setStatsById] = useState<Map<string, DockerContainerStats>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshAllRef = useRef<((initial: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled || !connectionId) {
      setContainers([]);
      setStatsById(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const refreshStats = async () => {
      const listStats = commands.dockerListContainerStats;
      if (typeof listStats !== "function") {
        debugDockerStats("dockerListContainerStats 未绑定", {
          label: debugLabel,
          connectionId,
          hint: "请重启 tauri dev 或运行 npm run gen:bindings",
        });
        return;
      }
      debugDockerStatsIpc("request", {
        connectionId,
        containerIds: null,
        label: debugLabel,
      });
      try {
        const statsList = await unwrap(commands.dockerListContainerStats(connectionId, null)).catch(
          (error) => {
            debugDockerStatsIpc("error", {
              connectionId,
              containerIds: null,
              label: debugLabel,
            }, { error: String(error) });
            return [] as DockerContainerStats[];
          },
        );
        if (cancelled) return;
        setStatsById(statsMapFromList(statsList));
        debugDockerStatsIpc("response", {
          connectionId,
          containerIds: null,
          label: debugLabel,
        }, summarizeStatsList(statsList));
      } catch (error) {
        debugDockerStatsIpc("error", {
          connectionId,
          containerIds: null,
          label: debugLabel,
        }, { error: String(error) });
      }
    };

    const refreshContainers = async () => {
      try {
        const list = await unwrap(commands.dockerListContainers(connectionId, null));
        if (cancelled) return;
        setContainers(list);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };

    const refreshAll = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        await Promise.all([refreshContainers(), refreshStats()]);
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };

    refreshAllRef.current = refreshAll;

    const bootstrap = () => {
      if (cancelled) return;
      void refreshAll(true);
      statsTimer = window.setInterval(() => void refreshStats(), statsPollMs);
      if (containersPollMs !== statsPollMs) {
        containersTimer = window.setInterval(() => void refreshContainers(), containersPollMs);
      }
    };

    let statsTimer: number | null = null;
    let containersTimer: number | null = null;
    const bootstrapTimer = window.setTimeout(bootstrap, 0);

    return () => {
      cancelled = true;
      refreshAllRef.current = null;
      window.clearTimeout(bootstrapTimer);
      if (statsTimer != null) window.clearInterval(statsTimer);
      if (containersTimer != null) window.clearInterval(containersTimer);
    };
  }, [connectionId, containersPollMs, debugLabel, enabled, statsPollMs]);

  const refreshNow = useCallback(() => {
    void refreshAllRef.current?.(false);
  }, []);

  const items = useMemo<DockerContainerGridItem[]>(
    () =>
      containers.map((container) => ({
        container,
        stats: pickStats(container, statsById),
      })),
    [containers, statsById],
  );

  useEffect(() => {
    if (!enabled || !connectionId || containers.length === 0) return;
    const matched = items.filter((item) => item.stats != null).length;
    debugDockerStats("容器 stats 匹配", {
      label: debugLabel,
      connectionId,
      containers: containers.length,
      statsKeys: statsById.size,
      matched,
      unmatched: items
        .filter((item) => item.stats == null && item.container.running)
        .slice(0, 5)
        .map((item) => ({
          id: item.container.id,
          shortId: item.container.shortId,
          name: item.container.name,
          running: item.container.running,
        })),
    });
  }, [connectionId, containers.length, debugLabel, enabled, items, statsById.size]);

  return { items, loading, error, refreshNow };
}
