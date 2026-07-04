import { useEffect } from "react";
import { commands } from "@/ipc/bindings";
import { RESOURCE_TAG_KEYS } from "@/lib/resourceTags";
import { useHostOverview } from "@/stores/sshHostStore";
import { useSshHostStore } from "@/stores/sshHostStore";
import { useSshStats, useSshStatsStore } from "@/stores/sshStatsStore";
import { persistResourceTag } from "@/stores/connectionStore";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";

/** 终端头部使用的主机快照：优先实时 stats，其次 SSH 概览缓存。 */
export function useTerminalSessionStats(
  resourceId: string | null,
  enabled: boolean,
) {
  const liveStats = useSshStats(resourceId);
  const overview = useHostOverview(resourceId);
  const stats = liveStats ?? overview.stats;

  useEffect(() => {
    if (!enabled || !resourceId || stats) return;

    let cancelled = false;
    const load =
      resourceId === LOCAL_TERMINAL_RESOURCE_ID
        ? commands.localFetchStats()
        : commands.sshPoolFetchStats(resourceId);

    void load.then((result) => {
      if (cancelled || result.status !== "ok") return;
      useSshStatsStore.getState().setStats([result.data]);
      useSshHostStore.getState().setOverview(resourceId, {
        stats: result.data,
        phase: "ready",
        updatedAt: Date.now(),
      });
      if (resourceId !== LOCAL_TERMINAL_RESOURCE_ID && result.data.osInfo?.trim()) {
        void persistResourceTag(resourceId, RESOURCE_TAG_KEYS.os, result.data.osInfo);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, resourceId, stats]);

  return stats;
}
