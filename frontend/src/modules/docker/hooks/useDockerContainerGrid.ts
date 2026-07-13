import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import { pickStats, statsMapFromList } from "../dockerContainerStatsMatch";
import { debugDockerStats } from "../dockerStatsDebug";

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
        debugDockerStats("dockerListContainerStats 未绑定", { label: debugLabel, connectionId });
        return;
      }
      try {
        const statsList = await unwrap(commands.dockerListContainerStats(connectionId, null)).catch(
          () => [] as DockerContainerStats[],
        );
        if (cancelled) return;
        setStatsById(statsMapFromList(statsList));
        debugDockerStats("stats 轮询", {
          label: debugLabel,
          connectionId,
          received: statsList.length,
        });
      } catch (error) {
        debugDockerStats("stats 轮询异常", { label: debugLabel, error: String(error) });
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
    void refreshAll(true);

    const statsTimer = window.setInterval(() => void refreshStats(), statsPollMs);
    const containersTimer =
      containersPollMs === statsPollMs
        ? null
        : window.setInterval(() => void refreshContainers(), containersPollMs);

    return () => {
      cancelled = true;
      refreshAllRef.current = null;
      window.clearInterval(statsTimer);
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

  return { items, loading, error, refreshNow };
}
