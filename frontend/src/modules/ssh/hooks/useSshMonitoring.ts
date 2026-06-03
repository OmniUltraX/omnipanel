import { useCallback, useEffect, useState } from "react";
import { commands } from "../../../ipc/bindings";
import { useSshStatsStore } from "../../../stores/sshStatsStore";
import {
  acquireSshPoolSession,
  releaseSshPoolSession,
} from "../../../stores/sshPoolSessionStore";

export type MonitoringPhase = "idle" | "loading" | "ready" | "error";

const POLL_INTERVAL_MS = 5_000;

export function useSshMonitoring(resourceId: string | null) {
  const [phase, setPhase] = useState<MonitoringPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!resourceId) return;
      if (!opts?.silent) {
        setPhase("loading");
        setError(null);
      }
      try {
        const result = await commands.sshPoolFetchStats(resourceId);
        if (result.status === "ok") {
          useSshStatsStore.getState().setStats([result.data]);
          setPhase("ready");
          setError(null);
        } else {
          setError(result.error?.message ?? "加载监控数据失败");
          setPhase("error");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [resourceId],
  );

  useEffect(() => {
    if (!resourceId) {
      setPhase("idle");
      setError(null);
      return;
    }

    acquireSshPoolSession(resourceId);
    void fetchStats();

    const interval = setInterval(() => {
      void fetchStats({ silent: true });
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      releaseSshPoolSession(resourceId);
    };
  }, [resourceId, fetchStats]);

  return { phase, error, refresh: () => fetchStats() };
}
