import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";

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

const POLL_MS = 2000;

function statsKey(containerId: string): string {
  return containerId.trim().toLowerCase();
}

function pickStats(
  container: DockerContainerSummary,
  statsById: Map<string, DockerContainerStats>,
): DockerContainerStats | null {
  const direct = statsById.get(statsKey(container.id));
  if (direct) return direct;
  const short = statsKey(container.shortId);
  for (const [key, stats] of statsById) {
    if (key.endsWith(short) || short.endsWith(key)) {
      return stats;
    }
  }
  return null;
}

export function useDockerContainerGrid(connectionId: string | null, enabled: boolean) {
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [statsById, setStatsById] = useState<Map<string, DockerContainerStats>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<((initial: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled || !connectionId) {
      setContainers([]);
      setStatsById(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const refresh = async (initial: boolean) => {
      if (initial) {
        setLoading(true);
      }
      try {
        const listPromise = unwrap(commands.dockerListContainers(connectionId, null));
        const statsPromise =
          typeof commands.dockerListContainerStats === "function"
            ? unwrap(commands.dockerListContainerStats(connectionId)).catch(() => [] as DockerContainerStats[])
            : Promise.resolve([] as DockerContainerStats[]);

        const [list, statsList] = await Promise.all([listPromise, statsPromise]);
        if (cancelled) return;

        const nextStats = new Map<string, DockerContainerStats>();
        for (const item of statsList) {
          nextStats.set(statsKey(item.containerId), item);
        }

        setContainers(list);
        setStatsById(nextStats);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
        }
      } finally {
        if (!cancelled && initial) {
          setLoading(false);
        }
      }
    };

    refreshRef.current = refresh;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = null;
      window.clearInterval(timer);
    };
  }, [connectionId, enabled]);

  const refreshNow = useCallback(() => {
    void refreshRef.current?.(false);
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
