import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DockerContainerStats, DockerContainerSummary } from "../../../ipc/bindings";
import {
  dockerSidebarCategoryRefreshKey,
  selectDockerSidebarCacheEntry,
} from "../dockerSidebarCache";
import { resolveComposeProjectName } from "../dockerComposeGroups";
import { pickStats } from "../dockerContainerStatsMatch";
import { useDockerContainerStats } from "./useDockerContainerStats";
import { useDockerSidebarCacheStore } from "../../../stores/dockerSidebarCacheStore";

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
