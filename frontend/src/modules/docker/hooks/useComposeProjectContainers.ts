import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import { selectDockerSidebarCacheEntry } from "../dockerSidebarCache";
import { resolveComposeProjectName } from "../dockerComposeGroups";
import { pickStats, statsMapFromList } from "../dockerContainerStatsMatch";
import { debugDockerStats } from "../dockerStatsDebug";
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
            .flatMap((container) => [container.id, container.name].filter((value) => value.trim().length > 0)),
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
    const targets = runningTargetsRef.current;
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
    try {
      const statsList = await unwrap(commands.dockerListContainerStats(connectionId, targets));
      const nextStats = statsMapFromList(statsList);
      setStatsById(nextStats);
      setStatsError(null);
      debugDockerStats("Compose stats 轮询", {
        project: projectKey,
        requestedTargets: targets.length,
        requestedSample: targets.slice(0, 3),
        received: statsList.length,
        sample: statsList.slice(0, 3).map((item) => ({
          containerId: item.containerId,
          name: item.name,
          cpuPercent: item.cpuPercent,
          memoryPercent: item.memoryPercent,
        })),
      });
    } catch (error) {
      setStatsError(String(error));
      debugDockerStats("Compose stats 请求失败", {
        project: projectKey,
        connectionId,
        error: String(error),
      });
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
    if (!enabled || !connectionId) {
      setStatsById(new Map());
      setStatsError(null);
      return;
    }

    const stale =
      sidebarEntry.refreshedAt == null ||
      Date.now() - sidebarEntry.refreshedAt > SIDEBAR_STALE_MS ||
      sidebarEntry.containers.length === 0;
    if (stale) {
      refreshContainers();
    }

    void refreshStats();
    const timer = window.setInterval(() => void refreshStats(), STATS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [
    connectionId,
    enabled,
    projectKey,
    refreshContainers,
    refreshStats,
    runningTargets.join("\0"),
    sidebarEntry.containers.length,
    sidebarEntry.refreshedAt,
  ]);

  useEffect(() => {
    if (!enabled || projectContainers.length === 0) return;
    const matched = items.filter((item) => item.stats != null).length;
    debugDockerStats("Compose stats 匹配", {
      project: projectKey,
      containers: projectContainers.length,
      matched,
      unmatched: items
        .filter((item) => item.stats == null)
        .slice(0, 5)
        .map((item) => ({
          id: item.container.id,
          shortId: item.container.shortId,
          name: item.container.name,
          running: item.container.running,
        })),
    });
  }, [enabled, items, projectContainers.length, projectKey]);

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
}
