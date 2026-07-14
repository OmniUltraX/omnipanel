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
  /** 当前缓存对应的连接；切走面板时保留，dock 重挂或换连接才重新拉取 */
  const loadedConnectionIdRef = useRef<string | null>(null);

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
    if (!connectionId) {
      setContainers([]);
      setLoading(false);
      setContainersError(null);
      loadedConnectionIdRef.current = null;
      refreshContainersRef.current = null;
      return;
    }

    if (!enabled) {
      // 停轮询，保留容器列表缓存
      refreshContainersRef.current = null;
      return;
    }

    let cancelled = false;
    const needsInitialFetch = loadedConnectionIdRef.current !== connectionId;
    if (needsInitialFetch && loadedConnectionIdRef.current != null) {
      // 切换连接到另一条时清空旧列表，避免短暂串数据
      setContainers([]);
      setContainersError(null);
    }

    const refreshContainers = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const list = await unwrap(commands.dockerListContainers(connectionId, null));
        if (cancelled) return;
        setContainers(list);
        setContainersError(null);
        loadedConnectionIdRef.current = connectionId;
      } catch (e) {
        if (!cancelled) setContainersError(String(e));
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };

    refreshContainersRef.current = () => refreshContainers(false);

    if (needsInitialFetch) {
      void refreshContainers(true);
    } else if (containersRef.current.length === 0) {
      // 重挂时未换连接且列表为空：补拉一次，避免只显示缓存且 stats 无处可挂
      void refreshContainers(false);
    }

    // 容器列表也要周期刷新（含与 stats 同间隔的场景），否则状态/CPU 关联会一直停留在初次结果
    const timer = window.setInterval(() => void refreshContainers(false), containersPollMs);

    return () => {
      cancelled = true;
      refreshContainersRef.current = null;
      window.clearInterval(timer);
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
