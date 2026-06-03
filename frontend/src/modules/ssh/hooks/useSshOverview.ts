import { useCallback, useEffect, useState } from "react";
import { commands, type SshProcessInfo } from "../../../ipc/bindings";
import type { HostSystemStats } from "../../../stores/sshStatsStore";
import { useSshStatsStore } from "../../../stores/sshStatsStore";
import {
  acquireSshPoolSession,
  releaseSshPoolSession,
} from "../../../stores/sshPoolSessionStore";

export type OverviewPhase = "idle" | "loading" | "ready" | "error";

export function useSshOverview(resourceId: string | null) {
  const [phase, setPhase] = useState<OverviewPhase>("idle");
  const [stats, setStats] = useState<HostSystemStats | null>(null);
  const [processes, setProcesses] = useState<SshProcessInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!resourceId) return;
      if (!opts?.silent) {
        setPhase("loading");
        setError(null);
      }
      try {
        const result = await commands.sshPoolLoadOverview(resourceId);
        if (result.status === "ok") {
          useSshStatsStore.getState().setStats([result.data.stats]);
          setStats(result.data.stats);
          setProcesses(result.data.processes);
          setPhase("ready");
          setError(null);
        } else {
          setError(result.error?.message ?? "加载概览失败");
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
      setStats(null);
      setProcesses([]);
      setError(null);
      return;
    }
    void load();
  }, [resourceId, load]);

  useEffect(() => {
    if (!resourceId || phase !== "ready") return;
    const interval = setInterval(() => {
      void load({ silent: true });
    }, 30_000);
    return () => clearInterval(interval);
  }, [resourceId, phase, load]);

  useEffect(() => {
    if (!resourceId) return;
    acquireSshPoolSession(resourceId);
    return () => {
      releaseSshPoolSession(resourceId);
    };
  }, [resourceId]);

  return {
    phase,
    stats,
    processes,
    error,
    refresh: () => load(),
  };
}
