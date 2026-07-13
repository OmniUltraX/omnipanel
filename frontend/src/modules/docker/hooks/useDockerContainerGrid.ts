import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import { DOCKER_STATS_POLL_MS, runningContainerIds } from "../dockerContainerStats";
import { pickStats } from "../dockerContainerStatsMatch";
import { useDockerContainerStats } from "./useDockerContainerStats";

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
};

export function useDockerContainerGrid(
  connectionId: string | null,
  enabled: boolean,
  options?: UseDockerContainerGridOptions,
) {
  const statsPollMs = options?.statsPollMs ?? DOCKER_STATS_POLL_MS;
  const containersPollMs = options?.containersPollMs ?? statsPollMs;

  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [containersError, setContainersError] = useState<string | null>(null);
  const containersRef = useRef(containers);
  containersRef.current = containers;

  const resolveContainerIds = useCallback(
    () => runningContainerIds(containersRef.current),
    [],
  );

  const {
    statsById,
    error: statsError,
    refreshNow: refreshStatsNow,
  } = useDockerContainerStats(connectionId, {
    enabled,
    pollMs: statsPollMs,
    resolveContainerIds,
  });

  const refreshContainersRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled || !connectionId) {
      setContainers([]);
      setLoading(false);
      setContainersError(null);
      return;
    }

    let cancelled = false;

    const refreshContainers = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const list = await unwrap(commands.dockerListContainers(connectionId, null));
        if (cancelled) return;
        setContainers(list);
        setContainersError(null);
      } catch (e) {
        if (!cancelled) setContainersError(String(e));
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };

    refreshContainersRef.current = () => refreshContainers(false);

    void refreshContainers(true);
    const timer =
      containersPollMs !== statsPollMs
        ? window.setInterval(() => void refreshContainers(false), containersPollMs)
        : null;

    return () => {
      cancelled = true;
      refreshContainersRef.current = null;
      if (timer != null) window.clearInterval(timer);
    };
  }, [connectionId, containersPollMs, enabled, statsPollMs]);

  const refreshNow = useCallback(() => {
    void refreshContainersRef.current?.();
    refreshStatsNow();
  }, [refreshStatsNow]);

  const items = useMemo<DockerContainerGridItem[]>(
    () =>
      containers.map((container) => ({
        container,
        stats: pickStats(container, statsById),
      })),
    [containers, statsById],
  );

  return {
    items,
    loading,
    error: statsError ?? containersError,
    refreshNow,
  };
}
