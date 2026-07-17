import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getEnvLabel, useI18n } from "../../i18n";
import { navigateToFeature } from "../../lib/workspaceNavigation";
import { useSshHostStore, type MonitorPoint } from "../../stores/sshHostStore";
import {
  formatBytes,
  formatUsageBytes,
  safePercent,
  type HostSystemStats,
} from "../../stores/sshStatsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  computeByteRate,
  formatRate,
  formatUptime,
  shortGpuName,
  sparklinePaths,
} from "../server/ssh/components/monitoring/monitoringUtils";
import { useSshActiveHostStore } from "../server/ssh/stores/sshActiveHostStore";
import { useSshWorkspaceNavStore } from "../server/ssh/stores/sshWorkspaceNavStore";
import {
  DONUT_C,
  DONUT_R,
  donutOffset,
  levelColor,
  resolveHostMonitorStatus,
  type HostMonitorStatus,
} from "./hostMonitorStatus";
import type { ActiveMonitoringHost } from "./useActiveMonitoringHosts";

const MAX_POINTS = 120;

function appendCpuPoint(
  history: MonitorPoint[],
  stats: HostSystemStats,
): MonitorPoint[] {
  const v = stats.cpuUsage ?? stats.cpu?.usage ?? null;
  if (v == null || stats.timestamp == null) return history;
  const ts = stats.timestamp * 1000;
  const last = history[history.length - 1];
  if (last && last.ts === ts) return history;
  return [...history.slice(-(MAX_POINTS - 1)), { ts, value: v }];
}

type Props = {
  host: ActiveMonitoringHost;
};

function statusLabel(
  status: HostMonitorStatus,
  t: (key: string) => string,
): string {
  if (status === "danger") return t("dashboard.resourceMonitor.statusDanger");
  if (status === "warn") return t("dashboard.resourceMonitor.statusWarn");
  return t("dashboard.resourceMonitor.statusOk");
}

function HmDonut({ pct, color }: { pct: number; color: string }) {
  const offset = donutOffset(pct);
  return (
    <div className="hm-donut">
      <svg viewBox="0 0 48 48" aria-hidden>
        <circle className="hm-donut-track" cx="24" cy="24" r={DONUT_R} />
        <circle
          className="hm-donut-fill"
          cx="24"
          cy="24"
          r={DONUT_R}
          stroke={color}
          strokeDasharray={DONUT_C.toFixed(2)}
          strokeDashoffset={offset.toFixed(2)}
        />
      </svg>
      <span className="hm-donut-val" style={{ color }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

export function ResourceMonitorHostCard({ host }: Props) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const prevStatsRef = useRef<HostSystemStats | null>(null);
  const appendMonitorPoints = useSshHostStore((s) => s.appendMonitorPoints);
  const stats = host.stats;
  const status = resolveHostMonitorStatus(stats);

  useEffect(() => {
    if (!stats) return;
    const cpuSeries = appendCpuPoint(host.cpuSeries, stats);
    if (cpuSeries !== host.cpuSeries) {
      appendMonitorPoints(host.resourceId, { cpuSeries });
    }
    prevStatsRef.current = stats;
  }, [stats, host.cpuSeries, host.resourceId, appendMonitorPoints]);

  const prev = prevStatsRef.current;
  const netUp =
    stats && prev && prev !== stats
      ? computeByteRate(prev, stats, (s) => s.network?.txBytes)
      : null;
  const netDown =
    stats && prev && prev !== stats
      ? computeByteRate(prev, stats, (s) => s.network?.rxBytes)
      : null;

  const cpuPct = Math.round(stats?.cpuUsage ?? stats?.cpu?.usage ?? 0);
  const memTotal = stats?.memory.total ?? 0;
  const memUsed = stats?.memory.used ?? 0;
  const memCache = (stats?.memory.cached ?? 0) + (stats?.memory.buffers ?? 0);
  // 与 SSH 概览一致：仪表盘百分比 = used/total；cache 只体现在进度条分段
  const memPct = memTotal > 0 ? safePercent(memUsed, memTotal) : 0;
  const usedPct = memPct;
  const cachePct = memTotal > 0 ? safePercent(memCache, memTotal) : 0;
  const diskPct = stats ? safePercent(stats.disk.used, stats.disk.total) : 0;
  const cores = stats?.cpuCores ?? stats?.cpu?.cores ?? 0;
  const osInfo = stats?.osInfo?.trim() || "";
  const subParts = [
    host.address || null,
    osInfo || null,
    cores > 0 ? t("dashboard.resourceMonitor.cores", { n: cores }) : null,
  ].filter(Boolean);

  const spark = sparklinePaths(
    host.cpuSeries.map((p) => p.value),
    200,
    26,
  );
  const gpus = stats?.gpu?.devices ?? [];
  const loadText = stats?.load?.trim() || "—";
  const uptimeText = formatUptime(stats?.uptimeSecs);

  const openHost = () => {
    // SSH 详情以 sshActiveHostStore 为准（优先于 selectedResourceByPath）
    useSshActiveHostStore.getState().setActiveHostId(host.resourceId);
    useSshWorkspaceNavStore.getState().selectHost();
    useWorkspaceStore.getState().selectResource(host.resourceId, host.path);
    navigateToFeature(host.path, navigate);
  };

  return (
    <article className="hm-card" data-status={status}>
      <div className="hm-head">
        <span className="hm-status-dot" aria-hidden />
        <div className="hm-title">
          <div className="hm-name">{host.name}</div>
          {subParts.length > 0 ? (
            <div className="hm-sub">{subParts.join(" · ")}</div>
          ) : null}
        </div>
        {host.environment !== "unknown" ? (
          <span className="hm-env-tag">{getEnvLabel(host.environment)}</span>
        ) : null}
        <span className="hm-badge">{statusLabel(status, t)}</span>
      </div>

      <div className="hm-gauges">
        <div className="hm-gauge">
          <HmDonut pct={cpuPct} color={levelColor(cpuPct)} />
          <span className="hm-gauge-label">CPU</span>
        </div>
        <div className="hm-gauge">
          <HmDonut pct={memPct} color={levelColor(memPct)} />
          <span className="hm-gauge-label">{t("dashboard.meta.memory")}</span>
        </div>
        <div className="hm-gauge">
          <HmDonut pct={diskPct} color={levelColor(diskPct)} />
          <span className="hm-gauge-label">{t("dashboard.meta.disk")}</span>
        </div>
      </div>

      {spark ? (
        <div className="hm-spark">
          <svg viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden>
            <path className="spark-area" d={spark.area} />
            <path className="spark-line" d={spark.line} />
          </svg>
        </div>
      ) : (
        <div className="hm-spark" aria-hidden />
      )}

      <div className="hm-rows">
        <div className="hm-row">
          <span className="hm-row-label">{t("dashboard.meta.memory")}</span>
          <div className="hm-bar">
            <span className="seg-used" style={{ width: `${usedPct}%` }} />
            <span className="seg-cache" style={{ width: `${cachePct}%` }} />
          </div>
          <span className="hm-row-val">
            {stats
              ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`
              : "—"}
          </span>
        </div>

        <div className="hm-row">
          <span className="hm-row-label">{t("dashboard.meta.disk")}</span>
          <div className="hm-bar">
            <span
              className={`seg-disk${diskPct >= 85 ? " crit" : ""}`}
              style={{ width: `${diskPct}%` }}
            />
          </div>
          <span className="hm-row-val">
            {stats
              ? formatUsageBytes(stats.disk.used, stats.disk.total)
              : "—"}
          </span>
        </div>

        {gpus.map((g, i) => {
          const util = Math.round(g.utilization ?? 0);
          const usedMiB =
            g.memoryUsed != null ? Math.round(g.memoryUsed / (1024 * 1024)) : null;
          const totalMiB =
            g.memoryTotal != null ? Math.round(g.memoryTotal / (1024 * 1024)) : null;
          const vram =
            usedMiB != null && totalMiB != null ? `${usedMiB} / ${totalMiB} MiB` : "—";
          const temp = g.temperature != null ? `${Math.round(g.temperature)}°C` : null;
          return (
            <div className="hm-row" key={`${g.index}-${g.name}`}>
              <span className="hm-row-label">{`GPU${i}`}</span>
              <div className="hm-bar">
                <span
                  className="seg-gpu"
                  style={{ width: `${Math.max(2, util)}%` }}
                />
              </div>
              <span className="hm-row-val">
                {[`${util}%`, vram, temp, shortGpuName(g.name) || null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          );
        })}

        <div className="hm-row">
          <span className="hm-row-label">{t("dashboard.resourceMonitor.network")}</span>
          <div className="hm-net-pair">
            <span className="up">↑ {formatRate(netUp)}</span>
            <span className="down">↓ {formatRate(netDown)}</span>
          </div>
          <span className="hm-row-val">
            {t("dashboard.resourceMonitor.procs", { n: host.processCount })}
          </span>
        </div>
      </div>

      <div className="hm-foot">
        <span>
          {t("dashboard.resourceMonitor.load", { load: loadText })}
        </span>
        <span>
          {t("dashboard.resourceMonitor.uptime", { uptime: uptimeText })}
        </span>
        <span className="hm-foot-spacer" />
        <button type="button" className="hm-open-btn" onClick={openHost}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
          {t("dashboard.resourceMonitor.openDetail")}
        </button>
      </div>
    </article>
  );
}
