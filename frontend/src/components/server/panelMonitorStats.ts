import type { HostSystemStats } from "@/stores/sshStatsStore";
import type { OnePanelDashboardBase } from "@/lib/onepanel/types";

function formatLoadString(load1?: number, load5?: number, load15?: number): string {
  if (load1 == null) return "—";
  return `${load1.toFixed(2)} ${(load5 ?? 0).toFixed(2)} ${(load15 ?? 0).toFixed(2)}`;
}

/** 将 1Panel / 宝塔仪表盘数据映射为 SSH 监控组件共用的 HostSystemStats。 */
export function dashboardToHostStats(
  hostId: string,
  dashboard: OnePanelDashboardBase,
  timestamp = Date.now(),
): HostSystemStats {
  const current = dashboard.currentInfo;
  const cpuCores = Math.max(1, dashboard.cpuCores ?? 1);
  const diskData = current?.diskData ?? [];

  const disks = diskData.map((d) => {
    const total = d.total ?? 0;
    const used = d.used ?? 0;
    const available = d.free ?? Math.max(0, total - used);
    return {
      name: d.path ?? "",
      mountPoint: d.path ?? "",
      fileSystem: "",
      total,
      used,
      available,
    };
  });

  let diskTotal = 0;
  let diskUsed = 0;
  let diskAvailable = 0;
  for (const d of disks) {
    diskTotal += d.total;
    diskUsed += d.used;
    diskAvailable += d.available;
  }

  const memTotal = current?.memoryTotal ?? 0;
  const memUsed = current?.memoryUsed ?? 0;
  const memAvailable = current?.memoryAvailable ?? Math.max(0, memTotal - memUsed);

  return {
    hostId,
    hostName: dashboard.hostname ?? "",
    load: formatLoadString(current?.load1, current?.load5, current?.load15),
    cpu: {
      usage: current?.cpuUsedPercent ?? 0,
      cores: cpuCores,
      perCoreUsage: [],
      load1: current?.load1 ?? 0,
      load5: current?.load5 ?? 0,
      load15: current?.load15 ?? 0,
      frequencyMhz: dashboard.cpuMhz ?? undefined,
    },
    cpuCores,
    cpuUsage: current?.cpuUsedPercent ?? 0,
    memory: {
      total: memTotal,
      used: memUsed,
      available: memAvailable,
      swapTotal: 0,
      swapUsed: 0,
      swapAvailable: 0,
    },
    disk: {
      total: diskTotal,
      used: diskUsed,
      available: diskAvailable,
      disks,
    },
    gpu: { devices: [] },
    network: {
      rxBytes: current?.netBytesRecv ?? 0,
      txBytes: current?.netBytesSent ?? 0,
    },
    osInfo: [dashboard.os, dashboard.platformVersion].filter(Boolean).join(" "),
    uptimeSecs: current?.uptime ?? undefined,
    timestamp,
  };
}
