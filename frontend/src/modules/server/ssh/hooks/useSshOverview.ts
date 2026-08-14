import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type SshProcessInfo } from "../../../../ipc/bindings";
import { canUseTerminalBackend } from "../../../../lib/isTauriRuntime";
import { RESOURCE_TAG_KEYS } from "../../../../lib/resourceTags";
import { persistResourceTag } from "../../../../stores/connectionStore";
import { useSshStatsStore } from "../../../../stores/sshStatsStore";
import {
  acquireSshPoolSession,
  releaseSshPoolSession,
} from "../../../../stores/sshPoolSessionStore";
import {
  useHostOverview,
  useSshHostStore,
  type OverviewPhase,
} from "../../../../stores/sshHostStore";
import {
  acquireOverviewPoller,
  releaseOverviewPoller,
  runOverviewLoadDedup,
  updateOverviewLoader,
} from "./sshOverviewScheduler";

export type { OverviewPhase };

/** 系统指标轮询间隔（ms） */
const SSH_STATS_POLL_MS = 30_000;
/** 进程列表轮询间隔（ms），与后端 PROCESSES_CACHE_TTL 对齐 */
const SSH_PROCESS_POLL_MS = 60_000;

export function useSshOverview(
  resourceId: string | null,
  options?: { processPolling?: boolean },
) {
  const processPolling = options?.processPolling ?? false;
  const overview = useHostOverview(resourceId);
  const setOverview = useSshHostStore((s) => s.setOverview);

  const load = useCallback(
    async (opts?: {
      silent?: boolean;
      processesOnly?: boolean;
      statsOnly?: boolean;
    }) => {
      if (!resourceId) return;

      if (opts?.processesOnly) {
        setOverview(resourceId, { refreshing: true });
        try {
          const result = await commands.sshPoolLoadProcesses(resourceId);
          if (result.status === "ok") {
            setOverview(resourceId, {
              processes: Array.isArray(result.data) ? result.data : [],
              processError: null,
              updatedAt: Date.now(),
              refreshing: false,
            });
          } else {
            setOverview(resourceId, {
              processError: result.error?.message ?? "加载进程列表失败",
              refreshing: false,
            });
          }
        } catch (e) {
          setOverview(resourceId, {
            processError: e instanceof Error ? e.message : String(e),
            refreshing: false,
          });
        }
        return;
      }

      if (opts?.statsOnly) {
        const snapshot = useSshHostStore.getState().getSnapshot(resourceId).overview;
        const hasCache = snapshot.phase === "ready" && snapshot.stats != null;
        if (opts.silent || hasCache) {
          setOverview(resourceId, { refreshing: true });
        }
        try {
          const statsResult = await commands.sshPoolFetchStats(resourceId);
          if (statsResult.status === "ok") {
            useSshStatsStore.getState().setStats([statsResult.data]);
            if (statsResult.data.osInfo?.trim()) {
              void persistResourceTag(
                resourceId,
                RESOURCE_TAG_KEYS.os,
                statsResult.data.osInfo,
              );
            }
            setOverview(resourceId, {
              phase: "ready",
              stats: statsResult.data,
              error: null,
              updatedAt: Date.now(),
              refreshing: false,
            });
          } else if (!hasCache) {
            setOverview(resourceId, {
              error: statsResult.error?.message ?? "加载概览失败",
              phase: "error",
              refreshing: false,
            });
          } else {
            setOverview(resourceId, { refreshing: false });
          }
        } catch (e) {
          if (!hasCache) {
            setOverview(resourceId, {
              error: e instanceof Error ? e.message : String(e),
              phase: "error",
              refreshing: false,
            });
          } else {
            setOverview(resourceId, { refreshing: false });
          }
        }
        return;
      }

      const snapshot = useSshHostStore.getState().getSnapshot(resourceId).overview;
      const hasCache = snapshot.phase === "ready" && snapshot.stats != null;
      if (!opts?.silent && !hasCache) {
        setOverview(resourceId, { phase: "loading", error: null });
      } else if (opts?.silent || hasCache) {
        setOverview(resourceId, { refreshing: true });
      }

      try {
        const statsPromise = commands.sshPoolFetchStats(resourceId);
        const processesPromise = processPolling
          ? commands.sshPoolLoadProcesses(resourceId)
          : null;

        const statsResult = await statsPromise;
        const statsOk = statsResult.status === "ok";

        if (statsOk) {
          useSshStatsStore.getState().setStats([statsResult.data]);
          if (statsResult.data.osInfo?.trim()) {
            void persistResourceTag(
              resourceId,
              RESOURCE_TAG_KEYS.os,
              statsResult.data.osInfo,
            );
          }
          setOverview(resourceId, {
            phase: "ready",
            stats: statsResult.data,
            error: null,
            updatedAt: Date.now(),
            refreshing: true,
          });
        }

        let processOk = true;
        let processErrorMsg: string | null = null;
        if (processesPromise) {
          const processResult = await processesPromise;
          if (processResult.status === "ok") {
            processOk = true;
            processErrorMsg = null;
            setOverview(resourceId, {
              processes: Array.isArray(processResult.data) ? processResult.data : [],
              processError: null,
              updatedAt: Date.now(),
            });
          } else {
            processOk = false;
            processErrorMsg = processResult.error?.message ?? "加载进程列表失败";
            setOverview(resourceId, { processError: processErrorMsg });
          }
        }

        if (statsOk) {
          setOverview(resourceId, {
            phase: "ready",
            processError: processOk ? null : processErrorMsg,
            refreshing: false,
          });
        } else if (processOk && processesPromise) {
          setOverview(resourceId, {
            phase: "ready",
            refreshing: false,
          });
        } else {
          setOverview(resourceId, {
            error: hasCache
              ? null
              : (statsResult.error?.message ?? processErrorMsg ?? "加载概览失败"),
            processError: processErrorMsg,
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
    [processPolling, resourceId, setOverview],
  );

  const statsPollLoad = useCallback(
    (opts?: { silent?: boolean; processesOnly?: boolean; statsOnly?: boolean }) => {
      if (opts?.processesOnly) {
        return load(opts);
      }
      if (opts?.silent) {
        return load({ silent: true, statsOnly: true });
      }
      return load(opts);
    },
    [load],
  );

  // 初始加载：有缓存则 silent；是否拉进程由 processPolling 决定
  useEffect(() => {
    if (!resourceId) return;

    const cached = useSshHostStore.getState().getSnapshot(resourceId).overview;
    if (cached.phase === "ready" && cached.stats) {
      useSshStatsStore.getState().setStats([cached.stats]);
    } else {
      setOverview(resourceId, { phase: "loading" });
    }

    if (processPolling) {
      void load({ silent: cached.phase === "ready" });
    } else {
      void load({ silent: cached.phase === "ready", statsOnly: true });
    }
  }, [processPolling, resourceId, load, setOverview]);

  // 全局轮询：仅刷新 CPU/内存等指标，不触发远程 ps
  useEffect(() => {
    if (!resourceId) return;
    acquireOverviewPoller(resourceId, statsPollLoad, SSH_STATS_POLL_MS);
    return () => {
      releaseOverviewPoller(resourceId);
    };
  }, [resourceId, statsPollLoad]);

  useEffect(() => {
    if (!resourceId) return;
    updateOverviewLoader(resourceId, statsPollLoad, SSH_STATS_POLL_MS);
  }, [resourceId, statsPollLoad]);

  // 仅在需要展示进程列表时轮询 ps（间隔较长）
  useEffect(() => {
    if (!resourceId || !processPolling) return;
    void load({ silent: true, processesOnly: true });
    const timer = window.setInterval(() => {
      void load({ silent: true, processesOnly: true });
    }, SSH_PROCESS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [load, processPolling, resourceId]);

  useEffect(() => {
    if (!resourceId) return;
    if (typeof window === "undefined" || !canUseTerminalBackend()) return;

    const unlistenPromise = listen<{ resourceId: string; processes: SshProcessInfo[] }>(
      "ssh-process-ports",
      (event) => {
        if (event.payload.resourceId !== resourceId) return;
        setOverview(resourceId, {
          processes: event.payload.processes,
          updatedAt: Date.now(),
        });
      },
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [resourceId, setOverview]);

  useEffect(() => {
    if (!resourceId) return;
    acquireSshPoolSession(resourceId);
    return () => {
      releaseSshPoolSession(resourceId);
    };
  }, [resourceId]);

  const refreshProcesses = useCallback(() => {
    void load({ silent: true, processesOnly: true });
  }, [load]);

  const refresh = useCallback(() => {
    if (!resourceId) return;
    const promise = runOverviewLoadDedup(resourceId);
    if (promise) void promise;
    else void load();
  }, [resourceId, load]);

  return {
    phase: overview.phase,
    stats: overview.stats,
    processes: overview.processes,
    error: overview.error,
    processError: overview.processError,
    updatedAt: overview.updatedAt,
    refreshing: overview.refreshing,
    refresh,
    refreshProcesses,
  };
}
