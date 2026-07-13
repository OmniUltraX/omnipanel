import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import {
  dockerSidebarCategoryRefreshKey,
  selectDockerSidebarCacheEntry,
} from "../dockerSidebarCache";
import { resolveComposeProjectName } from "../dockerComposeGroups";
import { pickStats, statsMapFromList } from "../dockerContainerStatsMatch";
import { debugDockerStats, debugDockerStatsIpc, summarizeStatsList } from "../dockerStatsDebug";
import { useDockerSidebarCacheStore } from "../../../stores/dockerSidebarCacheStore";

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export type ComposeProjectContainerItem = {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
};

const STATS_POLL_MS = 2000;
const SIDEBAR_STALE_MS = 30_000;
const STATS_REQUEST_TIMEOUT_MS = 45_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer != null) window.clearTimeout(timer);
  }
}

export function useComposeProjectContainers(
  connectionId: string,
  composeProject: string,
  enabled: boolean,
) {
  const projectKey = composeProject.trim();
  const sidebarEntry = useDockerSidebarCacheStore(
    useCallback(selectDockerSidebarCacheEntry(connectionId), [connectionId]),
  );
  const refreshScope = useDockerSidebarCacheStore((state) => state.refreshScope);

  const [statsById, setStatsById] = useState<Map<string, DockerContainerStats>>(new Map());
  const [statsError, setStatsError] = useState<string | null>(null);
  const runningTargetsRef = useRef<string[]>([]);
  const statsRequestGenRef = useRef(0);
  const statsInflightRef = useRef(false);

  const projectContainers = useMemo(
    () =>
      sidebarEntry.containers.filter(
        (container) => resolveComposeProjectName(container) === projectKey,
      ),
    [projectKey, sidebarEntry.containers],
  );

  const runningTargets = useMemo(
    () =>
      Array.from(
        new Set(
          projectContainers
            .filter((container) => container.running)
            .map((container) => container.shortId || container.id)
            .filter((value) => value.trim().length > 0),
        ),
      ),
    [projectContainers],
  );
  runningTargetsRef.current = runningTargets;

  const items = useMemo<ComposeProjectContainerItem[]>(
    () =>
      projectContainers.map((container) => ({
        container,
        stats: pickStats(container, statsById),
      })),
    [projectContainers, statsById],
  );

  const refreshContainers = useCallback(() => {
    void refreshScope({
      kind: "category",
      connectionId,
      category: "containers",
    });
  }, [connectionId, refreshScope]);

  const refreshStats = useCallback(async () => {
    if (statsInflightRef.current) {
      debugDockerStats("Compose stats 跳过：已有进行中的请求", { project: projectKey });
      return;
    }
    const targets = runningTargetsRef.current;
    const requestGen = ++statsRequestGenRef.current;
    const listStats = commands.dockerListContainerStats;
    if (typeof listStats !== "function") {
      debugDockerStats("dockerListContainerStats 未绑定", {
        connectionId,
        project: projectKey,
        hint: "请重启 tauri dev 或运行 npm run gen:bindings",
      });
      return;
    }
    if (targets.length === 0) {
      setStatsById(new Map());
      debugDockerStats("项目无运行中容器，跳过 stats", { project: projectKey });
      return;
    }

    statsInflightRef.current = true;
    debugDockerStatsIpc("request", {
      connectionId,
      containerIds: null,
      label: `compose:${projectKey}`,
      source: "ssh",
    }, {
      runningTargets: targets.length,
      runningSample: targets.slice(0, 3),
      note: "拉取全量 stats，前端按 shortId/name 匹配 Compose 容器",
    });

    try {
      const statsList = await withTimeout(
        unwrap(commands.dockerListContainerStats(connectionId, null)),
        STATS_REQUEST_TIMEOUT_MS,
        "dockerListContainerStats",
      );
      if (requestGen !== statsRequestGenRef.current) {
        debugDockerStats("Compose stats 丢弃过期响应", { project: projectKey, requestGen });
        return;
      }
      const nextStats = statsMapFromList(statsList);
      setStatsById(nextStats);
      setStatsError(null);
      debugDockerStatsIpc(
        "response",
        {
          connectionId,
          containerIds: null,
          label: `compose:${projectKey}`,
          source: "ssh",
        },
        {
          runningTargets: targets.length,
          ...summarizeStatsList(statsList),
        },
      );
    } catch (error) {
      if (requestGen !== statsRequestGenRef.current) return;
      setStatsError(String(error));
      debugDockerStatsIpc(
        "error",
        {
          connectionId,
          containerIds: null,
          label: `compose:${projectKey}`,
        },
        { error: String(error) },
      );
    } finally {
      statsInflightRef.current = false;
    }
  }, [connectionId, projectKey]);

  const refreshNow = useCallback(() => {
    refreshContainers();
    void refreshStats();
  }, [refreshContainers, refreshStats]);

  useEffect(() => {
    debugDockerStats("Compose 容器 hook", {
      enabled,
      connectionId,
      project: projectKey,
      cachedContainers: sidebarEntry.containers.length,
      projectContainers: projectContainers.length,
    });
  }, [connectionId, enabled, projectKey, projectContainers.length, sidebarEntry.containers.length]);

  useEffect(() => {
    if (!enabled || !connectionId) return;
    const stale =
      sidebarEntry.refreshedAt == null ||
      Date.now() - sidebarEntry.refreshedAt > SIDEBAR_STALE_MS ||
      sidebarEntry.containers.length === 0;
    if (stale) {
      refreshContainers();
    }
  }, [
    connectionId,
    enabled,
    projectKey,
    refreshContainers,
    sidebarEntry.containers.length,
    sidebarEntry.refreshedAt,
  ]);

  useEffect(() => {
    if (!enabled || !connectionId || runningTargets.length === 0) {
      setStatsById(new Map());
      setStatsError(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const start = async () => {
      const containersKey = dockerSidebarCategoryRefreshKey(connectionId, "containers");
      const deadline = Date.now() + 15_000;
      while (!cancelled && Date.now() < deadline) {
        const refreshing = useDockerSidebarCacheStore.getState().isRefreshing(containersKey);
        if (!refreshing) break;
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
      if (cancelled) return;
      await refreshStats();
      if (cancelled) return;
      timer = window.setInterval(() => void refreshStats(), STATS_POLL_MS);
    };

    // 推迟到下一宏任务，避免 React StrictMode 双挂载时第一次 invoke 回调被销毁。
    const bootstrapTimer = window.setTimeout(() => {
      void start();
    }, 0);

    return () => {
      cancelled = true;
      statsRequestGenRef.current += 1;
      window.clearTimeout(bootstrapTimer);
      if (timer != null) window.clearInterval(timer);
    };
  }, [connectionId, enabled, projectKey, refreshStats, runningTargets.join("\0")]);

  useEffect(() => {
    if (!enabled || projectContainers.length === 0) return;
    const matched = items.filter((item) => item.stats != null).length;
    debugDockerStats("Compose stats 匹配", {
      project: projectKey,
      containers: projectContainers.length,
      running: runningTargets.length,
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
  }, [enabled, items, projectContainers.length, projectKey, runningTargets.length, statsById.size]);

  const loading =
    enabled &&
    projectContainers.length === 0 &&
    (sidebarEntry.refreshedAt == null || sidebarEntry.containers.length === 0);

  return {
    items,
    loading,
    error: statsError ?? sidebarEntry.error,
    refreshNow,
  };
};
