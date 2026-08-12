import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import { asArray } from "../../../ipc/asArray";
import { unwrapCommand } from "../../../ipc/result";
import { peekDockerSidebarCache } from "../dockerSidebarCacheSeed";
import { handleDockerAutoFetchFailure, isBtPanelAuthOrLockoutError } from "../dockerConnectionOffline";
import {
  DOCKER_CONTAINERS_POLL_MS,
  DOCKER_STATS_INITIAL_DELAY_MS,
  DOCKER_STATS_POLL_MS,
  runningContainerIds,
} from "../dockerContainerStats";
import { pickStats } from "../dockerContainerStatsMatch";
import { useDockerContainerStats } from "./useDockerContainerStats";

const unwrap = unwrapCommand;

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
  const containersPollMs = options?.containersPollMs ?? DOCKER_CONTAINERS_POLL_MS;

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
    initialDelayMs: DOCKER_STATS_INITIAL_DELAY_MS,
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
    let stopPolling = false;
    let timer: number | null = null;
    const needsInitialFetch = loadedConnectionIdRef.current !== connectionId;
    if (needsInitialFetch) {
      // cache-first：换连接时先灌侧栏缓存，避免闪白串数感
      const cached = peekDockerSidebarCache(connectionId);
      startTransition(() => {
        setContainers(cached.containers);
        setContainersError(cached.error);
      });
    }

    const clearPollTimer = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const refreshContainers = async (initial: boolean) => {
      if (stopPolling) return;
      if (initial) setLoading(true);
      try {
        const list = asArray(
          await unwrap(commands.dockerListContainers(connectionId, null), {
            quiet: true,
          }),
        );
        if (cancelled) return;
        startTransition(() => {
          setContainers(list);
          setContainersError(null);
        });
        loadedConnectionIdRef.current = connectionId;
      } catch (e) {
        if (!cancelled) {
          if (isBtPanelAuthOrLockoutError(e)) {
            // 鉴权/封禁：只保留这次失败，停止后续自动轮询，避免被宝塔锁 IP
            stopPolling = true;
            clearPollTimer();
            setContainersError(String(e));
          } else if (handleDockerAutoFetchFailure(connectionId, e)) {
            setContainersError(null);
          } else {
            setContainersError(String(e));
          }
        }
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
    timer = window.setInterval(() => void refreshContainers(false), containersPollMs);

    return () => {
      cancelled = true;
      stopPolling = true;
      refreshContainersRef.current = null;
      clearPollTimer();
    };
  }, [connectionId, containersPollMs, enabled]);

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
