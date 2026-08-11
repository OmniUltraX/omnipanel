import { useEffect, useMemo, useState } from "react";
import { MonGauge } from "../../../server/ssh/components/monitoring/MonGauge";
import { MonSparkline } from "../../../server/ssh/components/monitoring/MonSparkline";
import { metricBarColor } from "../../../server/ssh/components/monitoring/monitoringUtils";
import { useMonitorSparklines } from "../../../server/ssh/components/monitoring/useMonitorSparklines";
import { useI18n } from "../../../../i18n";
import { MODULE_PATHS } from "../../../../lib/paths";
import {
  aggregateGpuUtilization,
  formatUsageBytes,
  safePercent,
  useSshStats,
} from "../../../../stores/sshStatsStore";
import {
  connectionToResource,
  useConnectionStore,
} from "../../../../stores/connectionStore";
import { useSshHostStore } from "../../../../stores/sshHostStore";
import { ResourceMonitorHostCard } from "../../ResourceMonitorHostCard";
import {
  useActiveMonitoringHosts,
  type ActiveMonitoringHost,
} from "../../useActiveMonitoringHosts";
import { useDashboardStore } from "../../useDashboardStore";
import type { SmallComponentController, SmallComponentRenderProps } from "../types";
import {
  resolveServerMonitorLayoutMode,
  type ServerMonitorLayoutMode,
} from "./layout";

type MetricKind = "cpu" | "mem" | "disk" | "gpu";
type TileVariant = "gaugeSpark" | "ring" | "bar";

type ServerMonitorController = SmallComponentController & {
  hostId: string | null;
  subscribe: (listener: () => void) => () => void;
};

function asServerMonitorController(
  controller: SmallComponentController | undefined,
): ServerMonitorController | null {
  if (!controller) return null;
  const c = controller as ServerMonitorController;
  if (typeof c.subscribe !== "function") return null;
  return c;
}

function metricAccent(kind: MetricKind): string | undefined {
  if (kind === "mem") return "var(--success)";
  if (kind === "disk") return "var(--warn)";
  if (kind === "gpu") return "#64d2ff";
  return undefined;
}

function variantForMode(mode: ServerMonitorLayoutMode): TileVariant {
  if (mode === "3x4") return "ring";
  if (mode === "4x2") return "bar";
  return "gaugeSpark";
}

function MetricTile({
  kind,
  label,
  percent,
  detail,
  sparkline,
  variant,
}: {
  kind: MetricKind;
  label: string;
  percent: number;
  detail: string;
  sparkline: number[];
  variant: TileVariant;
}) {
  const color = metricBarColor(percent, kind, metricAccent(kind));
  const pct = Math.round(percent);

  if (variant === "ring") {
    return (
      <div
        className="sc-server-mon__tile sc-server-mon__tile--ring"
        data-metric={kind}
        title={`${label} ${pct}%`}
      >
        <MonGauge percent={percent} color={color} />
        <span className="sc-server-mon__ring-label">{label}</span>
      </div>
    );
  }

  if (variant === "bar") {
    return (
      <div
        className="sc-server-mon__tile sc-server-mon__tile--bar"
        data-metric={kind}
        title={`${label} ${pct}%`}
      >
        <div className="sc-server-mon__bar-head">
          <span className="sc-server-mon__bar-label">{label}</span>
          <span className="sc-server-mon__bar-pct" style={{ color }}>
            {pct}%
          </span>
        </div>
        <div className="sc-server-mon__bar-track" aria-hidden>
          <div
            className="sc-server-mon__bar-fill"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      </div>
    );
  }

  // 4x4：圆环 + 折线
  return (
    <div className="sc-server-mon__tile sc-server-mon__tile--gauge-spark" data-metric={kind}>
      <div className="sc-server-mon__tile-head">
        <span className="sc-server-mon__tile-label">{label}</span>
        <span className="sc-server-mon__tile-pct" style={{ color }}>
          {pct}%
        </span>
      </div>
      <div className="sc-server-mon__tile-body">
        <MonGauge percent={percent} color={color} />
        <div className="sc-server-mon__tile-meta">
          <div className="sc-server-mon__tile-detail">{detail}</div>
          <MonSparkline
            values={sparkline}
            height={22}
            className="mon-sparkline sc-server-mon__spark"
          />
        </div>
      </div>
    </div>
  );
}

export function ServerResourceMonitorView({
  instanceId,
  panelId,
  controller,
  dataSourceId: dataSourceIdProp,
}: SmallComponentRenderProps) {
  const { t } = useI18n();
  const widget = useDashboardStore(
    (s) =>
      s.customPanels[panelId]?.widgets.find((w) => w.id === instanceId) ?? null,
  );
  const connections = useConnectionStore((s) => s.connections);
  const hosts = useActiveMonitoringHosts();
  const hostSnaps = useSshHostStore((s) => s.hosts);
  const [, setTick] = useState(0);

  const monitor = asServerMonitorController(controller);

  useEffect(() => {
    if (!monitor) return;
    return monitor.subscribe(() => setTick((n) => n + 1));
  }, [monitor]);

  const hostId = useMemo(() => {
    return dataSourceIdProp ?? widget?.dataSourceId ?? monitor?.hostId ?? null;
  }, [dataSourceIdProp, widget?.dataSourceId, monitor?.hostId]);

  const connection = useMemo(
    () => (hostId ? connections.find((c) => c.id === hostId) ?? null : null),
    [connections, hostId],
  );
  const hostMeta = hosts.find((h) => h.resourceId === hostId) ?? null;
  const liveStats = useSshStats(hostId);
  const snap = hostId ? hostSnaps[hostId] : undefined;
  const stats = liveStats ?? hostMeta?.stats ?? snap?.overview?.stats ?? null;
  const sparklines = useMonitorSparklines(stats);

  const layoutMode: ServerMonitorLayoutMode = resolveServerMonitorLayoutMode(
    widget?.sizeId,
    widget?.layout,
  );
  const variant = variantForMode(layoutMode);
  const compactChrome = variant === "ring" || variant === "bar";

  const cardHost: ActiveMonitoringHost | null = useMemo(() => {
    if (!hostId) return null;
    if (hostMeta) {
      return {
        ...hostMeta,
        stats: stats ?? hostMeta.stats,
      };
    }
    const resource = connection ? connectionToResource(connection) : null;
    return {
      resourceId: hostId,
      name: resource?.name ?? stats?.hostName ?? hostId,
      address: resource?.subtitle ?? "",
      path: resource?.modulePath ?? MODULE_PATHS.terminal,
      environment: resource?.environment ?? "unknown",
      stats,
      updatedAt:
        snap?.overview?.updatedAt ??
        (stats?.timestamp != null ? stats.timestamp * 1000 : null),
      cpuSeries: snap?.monitoring.cpuSeries ?? [],
      processCount: snap?.overview?.processes.length ?? 0,
    };
  }, [hostId, hostMeta, connection, stats, snap]);

  if (!hostId) {
    return (
      <div className="sc-server-mon sc-server-mon--empty">
        <p className="sc-server-mon__empty-title">
          {t("homeWorkspace.customPanel.dataSource.requiredTitle")}
        </p>
        <p className="sc-server-mon__empty-hint">
          {t("homeWorkspace.customPanel.dataSource.requiredHintSsh")}
        </p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="sc-server-mon sc-server-mon--empty">
        <p className="sc-server-mon__empty-title">
          {t("homeWorkspace.widgets.serverResourceMonitor.emptyTitle")}
        </p>
        <p className="sc-server-mon__empty-hint">
          {t("homeWorkspace.widgets.serverResourceMonitor.emptyHint")}
        </p>
      </div>
    );
  }

  // 3x3：复用资源监控主机卡（与首页资源监控页一致）
  if (layoutMode === "3x3" && cardHost) {
    return (
      <div className="sc-server-mon sc-server-mon--card" data-layout="3x3">
        <ResourceMonitorHostCard host={cardHost} />
      </div>
    );
  }

  const cpuPct = Math.round(stats.cpuUsage ?? stats.cpu?.usage ?? 0);
  const memPct = safePercent(stats.memory.used, stats.memory.total);
  const diskPct = safePercent(stats.disk.used, stats.disk.total);
  const gpuPct = aggregateGpuUtilization(stats.gpu) ?? 0;
  const cores = stats.cpuCores ?? stats.cpu?.cores ?? null;
  const hostName =
    connection?.name ?? hostMeta?.name ?? stats.hostName ?? hostId;
  const hostAddr = hostMeta?.address ?? "";

  const metrics: Array<{
    kind: MetricKind;
    label: string;
    percent: number;
    detail: string;
    sparkline: number[];
  }> = [
    {
      kind: "cpu",
      label: t("ssh.overview.cpu"),
      percent: cpuPct,
      detail:
        cores != null
          ? t("ssh.overview.cpuUsageCores", { usage: cpuPct, cores })
          : `${cpuPct}%`,
      sparkline: sparklines.cpu,
    },
    {
      kind: "mem",
      label: t("ssh.overview.memory"),
      percent: memPct,
      detail: formatUsageBytes(stats.memory.used, stats.memory.total),
      sparkline: sparklines.mem,
    },
    {
      kind: "disk",
      label: t("ssh.overview.disk"),
      percent: diskPct,
      detail: formatUsageBytes(stats.disk.used, stats.disk.total),
      sparkline: sparklines.disk,
    },
    {
      kind: "gpu",
      label: t("ssh.overview.gpu"),
      percent: gpuPct,
      detail:
        (stats.gpu?.devices?.length ?? 0) > 0
          ? t("homeWorkspace.widgets.serverResourceMonitor.gpuDevices", {
              count: stats.gpu?.devices?.length ?? 0,
            })
          : t("ssh.overview.gpuNotDetected"),
      sparkline: sparklines.gpu[0] ?? [],
    },
  ];

  return (
    <div
      className={
        compactChrome
          ? `sc-server-mon sc-server-mon--${variant === "ring" ? "rings" : "bars"}`
          : "sc-server-mon"
      }
      data-layout={layoutMode}
    >
      {!compactChrome ? (
        <div className="sc-server-mon__host">
          <span className="sc-server-mon__host-name">{hostName}</span>
          {hostAddr ? (
            <span className="sc-server-mon__host-addr">{hostAddr}</span>
          ) : null}
        </div>
      ) : null}

      <div className="sc-server-mon__metrics" data-layout={layoutMode}>
        {metrics.map((m) => (
          <MetricTile
            key={m.kind}
            kind={m.kind}
            label={m.label}
            percent={m.percent}
            detail={m.detail}
            sparkline={m.sparkline}
            variant={variant}
          />
        ))}
      </div>
    </div>
  );
}
