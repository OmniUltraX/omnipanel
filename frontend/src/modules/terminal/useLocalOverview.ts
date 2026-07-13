import { useCallback, useEffect } from "react";
import { commands } from "@/ipc/bindings";
import { LOCAL_TERMINAL_RESOURCE_ID } from "@/modules/terminal/paneResource";
import { useSshStatsStore } from "@/stores/sshStatsStore";
import { useSshHostStore, useHostOverview } from "@/stores/sshHostStore";
import {
  acquireOverviewPoller,
  releaseOverviewPoller,
  runOverviewLoadDedup,
  updateOverviewLoader,
} from "@/modules/server/ssh/hooks/sshOverviewScheduler";

/** 本地概览轮询间隔（ms），与后端 STATS_CACHE_TTL 对齐 */
const LOCAL_POLL_MS = 5_000;

/**
 * 本地终端监控概览 hook。
 *
 * 与 useSshOverview 架构对齐：
 * - 进程列表存入 useSshHostStore（resourceId = LOCAL_TERMINAL_RESOURCE_ID），
 *   多个本地终端面板共享同一份数据，避免每实例独立 useState
 * - 轮询定时器通过 sshOverviewScheduler 全局共享
 */
export function useLocalOverview(enabled: boolean) {
  const resourceId = LOCAL_TERMINAL_RESOURCE_ID;
  const overview = useHostOverview(enabled ? resourceId : null);
  const setOverview = useSshHostStore((s) => s.setOverview);
  const stats = useSshStatsStore(
    (s) => s.statsMap[LOCAL_TERMINAL_RESOURCE_ID] ?? null,
  );

  const load = useCallback(
    async (opts?: { silent?: boolean; processesOnly?: boolean }) => {
      if (!enabled) return;

      const cachedStats =
        useSshStatsStore.getState().statsMap[LOCAL_TERMINAL_RESOURCE_ID] ?? null;
      const hasCache = cachedStats != null;

      if (opts?.processesOnly) {
        setOverview(resourceId, { refreshing: true });
        try {
          const processResult = await commands.localListProcesses();
          if (processResult.status === "ok") {
            setOverview(resourceId, {
              processes: processResult.data,
              updatedAt: Date.now(),
              phase: "ready",
              refreshing: false,
            });
          } else {
            setOverview(resourceId, {
              refreshing: false,
            });
          }
        } catch {
          setOverview(resourceId, { refreshing: false });
        }
        return;
      }

      const snapshot = useSshHostStore.getState().getSnapshot(resourceId).overview;
      const hasOverviewCache = snapshot.phase === "ready" && snapshot.stats != null;

      if (!opts?.silent && !hasCache && !hasOverviewCache) {
        setOverview(resourceId, { phase: "loading", error: null });
      } else if (opts?.silent || hasCache || hasOverviewCache) {
        setOverview(resourceId, { refreshing: true });
      }

      try {
        const [processResult, statsResult] = await Promise.all([
          commands.localListProcesses(),
          commands.localFetchStats(),
        ]);

        const processOk = processResult.status === "ok";
        const statsOk = statsResult.status === "ok";

        if (processOk) {
          setOverview(resourceId, {
            processes: processResult.data,
            updatedAt: Date.now(),
          });
        }

        if (statsOk) {
          useSshStatsStore.getState().setStats([statsResult.data]);
        }

        if (processOk || statsOk) {
          setOverview(resourceId, {
            phase: "ready",
            error: null,
            refreshing: false,
          });
        } else {
          setOverview(resourceId, {
            error: hasCache
              ? null
              : (processResult.error?.message ??
                  statsResult.error?.message ??
                  "加载本机监控失败"),
            phase: hasCache ? "ready" : "error",
            refreshing: false,
          });
        }
      } catch (e) {
        setOverview(resourceId, {
          error: hasCache
            ? null
            : e instanceof Error
              ? e.message
              : String(e),
          phase: hasCache ? "ready" : "error",
          refreshing: false,
        });
      }
    },
    [enabled, resourceId, setOverview],
  );

  // 初始加载
  useEffect(() => {
    if (!enabled) return;
    const cachedStats =
      useSshStatsStore.getState().statsMap[LOCAL_TERMINAL_RESOURCE_ID] ?? null;
    const cachedOverview = useSshHostStore.getState().getSnapshot(resourceId).overview;
    const hasCache = cachedStats != null || cachedOverview.phase === "ready";
    setOverview(resourceId, { phase: hasCache ? "ready" : "loading" });
    void load({ silent: hasCache });
  }, [enabled, resourceId, load, setOverview]);

  // 全局轮询调度器：多个本地终端面板复用同一定时器
  useEffect(() => {
    if (!enabled) return;
    acquireOverviewPoller(resourceId, load, LOCAL_POLL_MS);
    return () => {
      releaseOverviewPoller(resourceId);
    };
  }, [enabled, resourceId, load]);

  // load 依赖变化时同步更新调度器内的 loader 引用
  useEffect(() => {
    if (!enabled) return;
    updateOverviewLoader(resourceId, load, LOCAL_POLL_MS);
  }, [enabled, resourceId, load]);

  const refreshProcesses = useCallback(() => {
    void load({ silent: true, processesOnly: true });
  }, [load]);

  const refresh = useCallback(() => {
    const promise = runOverviewLoadDedup(resourceId);
    if (promise) void promise;
    else void load();
  }, [resourceId, load]);

  return {
    phase: overview.phase,
    stats,
    processes: overview.processes,
    error: overview.error,
    processError: null,
    updatedAt: overview.updatedAt,
    refreshing: overview.refreshing,
    refresh,
    refreshProcesses,
  };
}
