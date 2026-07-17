import { useMemo } from "react";
import { connectionToResource, useConnectionStore } from "../../stores/connectionStore";
import { useSshHostStore } from "../../stores/sshHostStore";
import { useSshStatsStore } from "../../stores/sshStatsStore";
import type { HostSystemStats } from "../../stores/sshStatsStore";
import { MODULE_PATHS } from "../../lib/paths";

export type ActiveMonitoringHost = {
  resourceId: string;
  name: string;
  address: string;
  path: string;
  stats: HostSystemStats | null;
  /** 最近概览更新时间（若有） */
  updatedAt: number | null;
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
      const overview = hosts[resourceId]?.overview;
      items.push({
        resourceId,
        name: resource?.name ?? overview?.stats?.hostName ?? resourceId,
        address: resource?.subtitle ?? "",
        path: resource?.modulePath ?? MODULE_PATHS.ssh,
        stats: statsMap[resourceId] ?? overview?.stats ?? null,
        updatedAt: overview?.updatedAt ?? null,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [hosts, connections, statsMap]);
}
