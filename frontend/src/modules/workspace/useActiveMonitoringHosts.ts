import { useMemo } from "react";
import type { EnvironmentTag } from "../../lib/resourceRegistry";
import { MODULE_PATHS } from "../../lib/paths";
import { connectionToResource, useConnectionStore } from "../../stores/connectionStore";
import {
  useSshHostStore,
  type MonitorPoint,
} from "../../stores/sshHostStore";
import { useSshStatsStore, type HostSystemStats } from "../../stores/sshStatsStore";

export type ActiveMonitoringHost = {
  resourceId: string;
  name: string;
  address: string;
  path: string;
  environment: EnvironmentTag;
  stats: HostSystemStats | null;
  updatedAt: number | null;
  cpuSeries: MonitorPoint[];
  processCount: number;
};

/** 筛出已开启系统监控的 SSH 主机，供首页「资源监控」tab 使用 */
export function useActiveMonitoringHosts(): ActiveMonitoringHost[] {
  const hosts = useSshHostStore((s) => s.hosts);
  const connections = useConnectionStore((s) => s.connections);
  const statsMap = useSshStatsStore((s) => s.statsMap);

  return useMemo(() => {
    const enabledIds = Object.entries(hosts)
      .filter(([, snap]) => snap.monitoring.enabled)
      .map(([id]) => id);

    const items: ActiveMonitoringHost[] = [];
    for (const resourceId of enabledIds) {
      const conn = connections.find((c) => c.id === resourceId);
      const resource = conn ? connectionToResource(conn) : null;
      const snap = hosts[resourceId];
      const overview = snap?.overview;
      const stats = statsMap[resourceId] ?? overview?.stats ?? null;
      const updatedAt =
        overview?.updatedAt ??
        (stats?.timestamp != null ? stats.timestamp * 1000 : null);

      items.push({
        resourceId,
        name: resource?.name ?? stats?.hostName ?? resourceId,
        address: resource?.subtitle ?? "",
        path: resource?.modulePath ?? MODULE_PATHS.ssh,
        environment: resource?.environment ?? "unknown",
        stats,
        updatedAt,
        cpuSeries: snap?.monitoring.cpuSeries ?? [],
        processCount: overview?.processes.length ?? 0,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [hosts, connections, statsMap]);
}
