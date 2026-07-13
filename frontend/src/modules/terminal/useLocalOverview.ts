import { useCallback, useEffect, useState } from "react";
import { commands, type SshProcessInfo } from "@/ipc/bindings";
import type { OverviewPhase } from "@/modules/server/ssh/hooks/useSshOverview";
import { LOCAL_TERMINAL_RESOURCE_ID } from "@/modules/terminal/paneResource";
import { useSshStatsStore } from "@/stores/sshStatsStore";

const LOCAL_POLL_MS = 5_000;

export function useLocalOverview(enabled: boolean) {
  const [phase, setPhase] = useState<OverviewPhase>("idle");
  const [processes, setProcesses] = useState<SshProcessInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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
        setRefreshing(true);
        try {
          const processResult = await commands.localListProcesses();
          if (processResult.status === "ok") {
            setProcesses(processResult.data);
            setUpdatedAt(Date.now());
            setPhase("ready");
          }
        } finally {
          setRefreshing(false);
        }
        return;
      }

      if (!opts?.silent && !hasCache) {
        setPhase("loading");
        setError(null);
      } else {
        setRefreshing(true);
      }

      try {
        const [processResult, statsResult] = await Promise.all([
          commands.localListProcesses(),
          commands.localFetchStats(),
        ]);

        const processOk = processResult.status === "ok";
        const statsOk = statsResult.status === "ok";

        if (processOk) {
          setProcesses(processResult.data);
          setUpdatedAt(Date.now());
        }

        if (statsOk) {
          useSshStatsStore.getState().setStats([statsResult.data]);
        }

        if (processOk || statsOk) {
          setPhase("ready");
          setError(null);
        } else {
          setError(
            hasCache
              ? null
              : (processResult.error?.message ??
                  statsResult.error?.message ??
                  "加载本机监控失败"),
          );
          setPhase(hasCache ? "ready" : "error");
        }
      } catch (e) {
        setError(
          hasCache
            ? null
            : e instanceof Error
              ? e.message
              : String(e),
        );
        setPhase(hasCache ? "ready" : "error");
      } finally {
        setRefreshing(false);
      }
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    const cachedStats =
      useSshStatsStore.getState().statsMap[LOCAL_TERMINAL_RESOURCE_ID] ?? null;
    setPhase(cachedStats ? "ready" : "loading");
    void load({ silent: cachedStats != null });
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || phase !== "ready") return;
    const interval = setInterval(() => {
      void load({ silent: true });
    }, LOCAL_POLL_MS);
    return () => clearInterval(interval);
  }, [enabled, phase, load]);

  const refreshProcesses = useCallback(() => {
    void load({ silent: true, processesOnly: true });
  }, [load]);

  return {
    phase,
    stats,
    processes,
    error,
    processError: null,
    updatedAt,
    refreshing,
    refresh: () => load(),
    refreshProcesses,
  };
}
