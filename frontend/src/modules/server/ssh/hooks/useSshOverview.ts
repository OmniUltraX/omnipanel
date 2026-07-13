import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type SshProcessInfo } from "../../../../ipc/bindings";
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

/** SSH 概览轮询间隔（ms），与后端 PROCESSES_CACHE_TTL 对齐 */
const SSH_POLL_MS = 30_000;

export function useSshOverview(resourceId: string | null) {
  const overview = useHostOverview(resourceId);
  const setOverview = useSshHostStore((s) => s.setOverview);

  const load = useCallback(
    async (opts?: { silent?: boolean; processesOnly?: boolean }) => {
      if (!resourceId) return;

      if (opts?.processesOnly) {
        setOverview(resourceId, { refreshing: true });
        try {
          const result = await commands.sshPoolLoadProcesses(resourceId);
          if (result.status === "ok") {
            setOverview(resourceId, {
              processes: result.data,
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

      const snapshot = useSshHostStore.getState().getSnapshot(resourceId).overview;
      const hasCache = snapshot.phase === "ready" && snapshot.stats != null;
      if (!opts?.silent && !hasCache) {
        setOverview(resourceId, { phase: "loading", error: null });
      } else if (opts?.silent || hasCache) {
        setOverview(resourceId, { refreshing: true });
      }

      try {
        const processesPromise = commands.sshPoolLoadProcesses(resourceId);
        const statsPromise = commands.sshPoolFetchStats(resourceId);

        const processResult = await processesPromise;
        const processOk = processResult.status === "ok";
        const processErrorMsg = processOk
          ? null
          : (processResult.error?.message ?? "加载进程列表失败");

        if (processOk) {
          setOverview(resourceId, {
            phase: "ready",
            processes: processResult.data,
            processError: null,
            updatedAt: Date.now(),
            refreshing: true,
          });
        } else {
          setOverview(resourceId, {
            processError: processErrorMsg,
            refreshing: true,
          });
        }

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
            processError: processOk ? null : processErrorMsg,
            updatedAt: Date.now(),
            refreshing: false,
          });
        } else if (processOk) {
          setOverview(resourceId, {
            phase: "ready",
            processError: null,
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
    [resourceId, setOverview],
  );

  // 初始加载：命中缓存直接复用，否则发起新请求
  useEffect(() => {
    if (!resourceId) return;

    const cached = useSshHostStore.getState().getSnapshot(resourceId).overview;
    if (cached.phase === "ready" && cached.stats) {
      useSshStatsStore.getState().setStats([cached.stats]);
    } else {
      setOverview(resourceId, { phase: "loading" });
    }

    void load({ silent: cached.phase === "ready" });
  }, [resourceId, load, setOverview]);

  // 全局轮询调度器：相同 resourceId 的多个面板复用同一定时器
  useEffect(() => {
    if (!resourceId) return;
    acquireOverviewPoller(resourceId, load, SSH_POLL_MS);
    return () => {
      releaseOverviewPoller(resourceId);
    };
  }, [resourceId, load]);

  // load 依赖变化时同步更新调度器内的 loader 引用（避免闭包过期）
  useEffect(() => {
    if (!resourceId) return;
    updateOverviewLoader(resourceId, load, SSH_POLL_MS);
  }, [resourceId, load]);

  useEffect(() => {
    if (!resourceId) return;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

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
    // 用户手动刷新：走调度器去重逻辑（非 silent，强制执行）
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
