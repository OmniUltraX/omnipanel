import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import {
  selectDockerSidebarCacheEntry,
} from "../dockerSidebarCache";
import { resolveComposeProjectName } from "../dockerComposeGroups";
import { DOCKER_STATS_POLL_MS } from "../dockerContainerStats";
import { pickStats } from "../dockerContainerStatsMatch";
import { useDockerContainerStats } from "./useDockerContainerStats";
import { useDockerSidebarCacheStore } from "../../../stores/dockerSidebarCacheStore";

export type ComposeProjectContainerItem = {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
};

const STATS_POLL_MS = DOCKER_STATS_POLL_MS;

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

  const projectContainers = useMemo(
    () =>
      sidebarEntry.containers.filter(
        (container) => resolveComposeProjectName(container) === projectKey,
      ),
    [projectKey, sidebarEntry.containers],
  );

  const runningTargetsRef = useRef<string[]>([]);
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

  const resolveContainerIds = useCallback(() => runningTargetsRef.current, []);

  const statsEnabled = enabled && runningTargets.length > 0;
  const { statsById, error: statsError, refreshNow: refreshStatsNow } = useDockerContainerStats(
    connectionId,
    {
      enabled: statsEnabled,
      pollMs: STATS_POLL_MS,
      resolveContainerIds,
    },
  );

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

  const refreshNow = useCallback(() => {
    refreshContainers();
    refreshStatsNow();
  }, [refreshContainers, refreshStatsNow]);

  // 侧栏容器列表走缓存：仅从未拉取过时补一次；后续靠节点刷新按钮或生命周期 refreshNow
  const containersLoaded = Boolean(sidebarEntry.loadedCategories?.containers);
  useEffect(() => {
    if (!enabled || !connectionId) return;
    if (containersLoaded) return;
    refreshContainers();
  }, [connectionId, containersLoaded, enabled, refreshContainers]);

  const loading = enabled && projectContainers.length === 0 && !containersLoaded;

  return {
    items,
    loading,
    error: statsError ?? sidebarEntry.error,
    refreshNow,
  };
}
