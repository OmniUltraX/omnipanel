import { useEffect, useMemo, useState } from "react";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { commands, type Connection, type DockerConnectionInfo, type SshTunnelInfo } from "../../../../ipc/bindings";
import { useConnectionStore } from "../../../../stores/connectionStore";
import { useSshStatsStore, formatUsageBytes, safePercent } from "../../../../stores/sshStatsStore";
import { useHostOverview } from "../../../../stores/sshHostStore";
import { useTerminalStore } from "../../../../stores/terminalStore";
import { findPanelForSsh, parsePanelConfig } from "../../panel/serverConnection";
import { getProfile } from "../data/hostProfiles";
import type { LaunchPreset } from "../types";
import { isBtPanelService, isOnePanelService } from "../../panel/panelPlugin";

export interface SshHostContext {
  connection: Connection | undefined;
  stats: ReturnType<typeof useSshStatsStore.getState>["statsMap"][string] | null;
  overviewPhase: string;
  osInfo: string | null;
  uptimeSecs: number | null;
  cpuLabel: string | null;
  memoryLabel: string | null;
  diskLabel: string | null;
  dockerConnection: DockerConnectionInfo | null;
  panelConnection: Connection | undefined;
  panelServiceLabel: string | null;
  tunnelCount: number;
  activeTunnelCount: number;
  lastSessionAt: number | null;
  openSessionCount: number;
  presets: LaunchPreset[];
  envTag: string | null;
}

export function useSshHostContext(
  resourceId: string | null,
  resource: WorkspaceResource | null,
): SshHostContext {
  const connections = useConnectionStore((s) => s.connections);
  const stats = useSshStatsStore((s) => (resourceId ? s.statsMap[resourceId] ?? null : null));
  const overview = useHostOverview(resourceId);
  const terminalSessions = useTerminalStore((s) => s.sessions);

  const [dockerConnections, setDockerConnections] = useState<DockerConnectionInfo[]>([]);
  const [tunnels, setTunnels] = useState<SshTunnelInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void commands.dockerListConnections().then((res) => {
      if (cancelled || res.status !== "ok") return;
      setDockerConnections(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  useEffect(() => {
    if (!resourceId) {
      setTunnels([]);
      return;
    }
    let cancelled = false;
    void commands.sshListTunnels().then((res) => {
      if (cancelled || res.status !== "ok") return;
      setTunnels(res.data.filter((t) => t.connectionId === resourceId));
    });
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  const connection = useMemo(
    () => connections.find((c) => c.id === resourceId),
    [connections, resourceId],
  );

  const panelConnection = useMemo(
    () => (resourceId ? findPanelForSsh(connections, resourceId) : undefined),
    [connections, resourceId],
  );

  const panelServiceLabel = useMemo(() => {
    if (!panelConnection) return null;
    const serviceType = parsePanelConfig(panelConnection).serviceType;
    return isOnePanelService(serviceType) ? "1Panel" : isBtPanelService(serviceType) ? "宝塔" : panelConnection.name;
  }, [panelConnection]);

  const dockerConnection = useMemo(
    () =>
      resourceId
        ? dockerConnections.find((c) => c.boundSshConnectionId === resourceId) ?? null
        : null,
    [dockerConnections, resourceId],
  );

  const hostSessions = useMemo(
    () =>
      resourceId
        ? terminalSessions.filter(
            (s) => s.session.resourceId === resourceId && s.session.type === "remote",
          )
        : [],
    [resourceId, terminalSessions],
  );

  const lastSessionAt = useMemo(() => {
    if (hostSessions.length === 0) return null;
    return hostSessions.reduce((max, s) => Math.max(max, s.lastActiveAt), 0);
  }, [hostSessions]);

  const openSessionCount = useMemo(
    () => hostSessions.filter((s) => s.lifecycle !== "ended").length,
    [hostSessions],
  );

  const presets = useMemo(() => getProfile(resource).presets, [resource]);

  const cpuPct = stats ? Math.round(stats.cpuUsage ?? stats.cpu?.usage ?? 0) : null;
  const diskPct = stats?.disk ? safePercent(stats.disk.used, stats.disk.total) : null;

  const activeTunnelCount = useMemo(
    () => tunnels.filter((t) => t.status === "active" || t.status === "running").length,
    [tunnels],
  );

  return {
    connection,
    stats,
    overviewPhase: overview.phase,
    osInfo: stats?.osInfo?.trim() || null,
    uptimeSecs: stats?.uptimeSecs ?? null,
    cpuLabel: cpuPct != null ? `${Math.round(cpuPct)}%` : null,
    memoryLabel: stats?.memory
      ? formatUsageBytes(stats.memory.used, stats.memory.total)
      : null,
    diskLabel: diskPct != null ? `${Math.round(diskPct)}%` : null,
    dockerConnection,
    panelConnection,
    panelServiceLabel,
    tunnelCount: tunnels.length,
    activeTunnelCount,
    lastSessionAt,
    openSessionCount,
    presets,
    envTag: connection?.envTag ?? null,
  };
}
