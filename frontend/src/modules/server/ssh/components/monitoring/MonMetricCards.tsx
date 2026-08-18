import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  aggregateGpuUtilization,
  formatBytes,
  formatUsageBytes,
  safePercent,
  type HostSystemStats,
} from "@/stores/sshStatsStore";
import { MonGauge } from "./MonGauge";
import { MonSparkline } from "./MonSparkline";
import {
  coreLoadLevel,
  cpuStatusBadge,
  diskStatusBadge,
  formatMiB,
  formatRate,
  memStatusBadge,
  metricBarColor,
  shortGpuName,
  type StatusBadge,
} from "./monitoringUtils";
import type { MonitorSparklines } from "./useMonitorSparklines";

function StatusBadgePill({ badge }: { badge: StatusBadge }) {
  return (
    <span className={`badge badge-${badge.tone}`} style={{ fontSize: 9 }}>
      {badge.label}
    </span>
  );
}

function CpuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M10 14h.01M14 14h.01M18 14h.01" />
    </svg>
  );
}

function DiskIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function GpuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M6 11h4M6 15h4M14 11h4M14 15h4" />
    </svg>
  );
}

type Props = {
  stats: HostSystemStats;
  sparklines: MonitorSparklines;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  /** 面板概览等窄高场景：去掉趋势图与次级明细 */
  compact?: boolean;
};

export function MonMetricCards({ stats, sparklines, diskReadRate, diskWriteRate, compact = false }: Props) {
  const { t } = useI18n();

  const cpuPct = Math.round(stats.cpuUsage ?? stats.cpu?.usage ?? 0);
  const cores = stats.cpuCores ?? stats.cpu?.cores ?? 1;
  const freq = stats.cpu?.frequencyMhz;
  const temp = stats.cpu?.temperature;
  const perCore = stats.cpu?.perCoreUsage ?? [];

  const memPct = safePercent(stats.memory.used, stats.memory.total);
  const memTotal = stats.memory.total ?? 0;
  const cached = stats.memory.cached ?? 0;
  const buffers = stats.memory.buffers ?? 0;
  const cachePct = memTotal > 0 ? safePercent(cached + buffers, memTotal) : 0;
  const usedPct = memTotal > 0 ? safePercent(stats.memory.used, memTotal) : 0;
  const freePct = Math.max(0, 100 - usedPct - cachePct);

  const diskPct = safePercent(stats.disk.used, stats.disk.total);
  const diskList = stats.disk.disks ?? [];
  const ioLine =
    diskReadRate != null || diskWriteRate != null
      ? ` · ↑ ${formatRate(diskReadRate)} ↓ ${formatRate(diskWriteRate)}`
      : "";

  const gpuDevices = stats.gpu?.devices ?? [];
  const hasGpu = gpuDevices.length > 0;

  return (
    <div className={cn("mon-metrics", !hasGpu && "mon-metrics--no-gpu")}>
      {/* CPU */}
      <div className="mon-card" data-metric="cpu">
        <div className="mon-card-head">
          <div className="mon-card-title">
            <span className="mon-card-icon"><CpuIcon /></span>
            {t("ssh.overview.cpu")}
          </div>
          <StatusBadgePill badge={cpuStatusBadge(cpuPct)} />
        </div>
        <div className="mon-card-main">
          <MonGauge
            percent={cpuPct}
            color={metricBarColor(cpuPct, "cpu")}
          />
          <div className="mon-card-stats">
            <div className="mon-card-primary">
              {cpuPct}% {t("ssh.monitor.usage")} · {cores} {t("ssh.monitor.cores")}
              {freq != null
                ? ` · ${freq >= 1000 ? `${(freq / 1000).toFixed(1)} GHz` : `${Math.round(freq)} MHz`}`
                : ""}
            </div>
            <div className="mon-card-secondary">
              {t("ssh.overview.loadLine", { load: stats.load })}
              {temp != null ? ` · ${Math.round(temp)}°C` : ""}
            </div>
            {perCore.length > 0 && !compact && (
              <div className="mon-core-grid">
                {perCore.map((u, i) => (
                  <span
                    key={`core-${i}`}
                    className="mon-core-cell"
                    data-load={coreLoadLevel(u ?? 0)}
                    title={`#${i + 1} ${Math.round(u ?? 0)}%`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        {!compact && <MonSparkline values={sparklines.cpu} />}
      </div>

      {/* Memory */}
      <div className="mon-card" data-metric="mem">
        <div className="mon-card-head">
          <div className="mon-card-title">
            <span className="mon-card-icon"><MemoryIcon /></span>
            {t("ssh.overview.memory")}
          </div>
          <StatusBadgePill badge={memStatusBadge(memPct)} />
        </div>
        <div className="mon-card-main">
          <MonGauge
            percent={memPct}
            color={metricBarColor(memPct, "mem", "var(--success)")}
          />
          <div className="mon-card-stats">
            <div className="mon-card-primary">
              {formatUsageBytes(stats.memory.used, stats.memory.total)}
            </div>
            <div className="mon-card-secondary">
              {t("ssh.overview.memAvailable", { size: formatBytes(stats.memory.available) })}
              {stats.memory.swapTotal && stats.memory.swapTotal > 0
                ? ` · Swap ${formatUsageBytes(stats.memory.swapUsed, stats.memory.swapTotal)}`
                : ""}
            </div>
            {memTotal > 0 && !compact && (
              <>
                <div className="mon-mem-stack">
                  <span className="mon-mem-used" style={{ width: `${usedPct}%` }} />
                  {cachePct > 0 && (
                    <span className="mon-mem-cache" style={{ width: `${cachePct}%` }} />
                  )}
                </div>
                <div className="mon-mem-legend">
                  <span>
                    <i style={{ background: "var(--success)" }} />
                    {t("ssh.monitor.memUsed")} {usedPct}%
                  </span>
                  {cachePct > 0 && (
                    <span>
                      <i
                        style={{
                          background:
                            "color-mix(in oklch, var(--success) 50%, var(--bg-deeper))",
                        }}
                      />
                      {t("ssh.monitor.memCache")} {cachePct}%
                    </span>
                  )}
                  <span>
                    <i
                      style={{
                        background: "var(--bg-deeper)",
                        border: "1px solid var(--border)",
                      }}
                    />
                    {t("ssh.monitor.memFree")} {freePct}%
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
        {!compact && <MonSparkline values={sparklines.mem} />}
      </div>

      {/* Disk */}
      <div className="mon-card" data-metric="disk">
        <div className="mon-card-head">
          <div className="mon-card-title">
            <span className="mon-card-icon"><DiskIcon /></span>
            {t("ssh.overview.disk")}
          </div>
          <StatusBadgePill badge={diskStatusBadge(diskPct)} />
        </div>
        <div className="mon-card-main">
          <MonGauge
            percent={diskPct}
            color={metricBarColor(diskPct, "disk", "var(--warn)")}
          />
          <div className="mon-card-stats">
            <div className="mon-card-primary">
              {formatUsageBytes(stats.disk.used, stats.disk.total)}
              {ioLine}
            </div>
            {diskList.length > 0 && !compact ? (
              <div className="mon-mount-list">
                {diskList.slice(0, 3).map((d) => {
                  const pct = safePercent(d.used, d.total);
                  return (
                    <div key={d.mountPoint || d.name} className="mon-mount-row">
                      <span className="mount-path" title={d.mountPoint}>
                        {d.mountPoint || d.name}
                      </span>
                      <div className="mon-mount-bar">
                        <div
                          className="mon-mount-bar-fill"
                          style={{
                            width: `${pct}%`,
                            background: metricBarColor(pct, "disk", "var(--warn)"),
                          }}
                        />
                      </div>
                      <span
                        className="mount-pct"
                        style={pct >= 90 ? { color: "var(--danger)" } : undefined}
                      >
                        {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {diskList.length > 3 && !compact && (
              <div className="mon-card-secondary">
                {t("ssh.overview.diskMore", { count: diskList.length - 3 })}
              </div>
            )}
          </div>
        </div>
        {!compact && <MonSparkline values={sparklines.disk} />}
      </div>

      {/* GPU */}
      {hasGpu ? (
      <div className="mon-card" data-metric="gpu">
        <div className="mon-card-head">
          <div className="mon-card-title">
            <span className="mon-card-icon"><GpuIcon /></span>
            {t("ssh.overview.gpu")}
          </div>
          <span className="badge badge-accent" style={{ fontSize: 9 }}>
            {gpuDevices.length === 1
              ? shortGpuName(gpuDevices[0].name) || "GPU"
              : `${gpuDevices.length}× GPU`}
          </span>
        </div>
          <div
            className={`mon-gpu-list${gpuDevices.length > 1 ? " mon-gpu-list--row" : ""}`}
          >
            {gpuDevices.map((d, i) => {
              const util = d.utilization != null ? Math.round(d.utilization) : null;
              const memUsed = d.memoryUsed;
              const memTotal = d.memoryTotal;
              return (
                <div key={`gpu-${d.index}-${i}`} className="mon-gpu-item">
                  <div className="mon-gpu-item-head">
                    <span>
                      GPU {d.index} · {shortGpuName(d.name) || d.name}
                    </span>
                    <span className="gpu-idx">
                      {util != null ? `${util}% ${t("ssh.monitor.gpuUtil")}` : "—"}
                    </span>
                  </div>
                  <div className="mon-gpu-metrics">
                    <span>
                      {t("ssh.monitor.gpuMem")}
                      <strong>
                        {formatMiB(memUsed)} / {formatMiB(memTotal)}
                      </strong>
                    </span>
                    <span>
                      {t("ssh.monitor.gpuTemp")}
                      <strong>
                        {d.temperature != null ? `${Math.round(d.temperature)}°C` : "—"}
                      </strong>
                    </span>
                    <span>
                      {t("ssh.monitor.gpuPower")}
                      <strong>
                        {d.power != null ? Math.round(d.power) : "—"}
                        {d.powerLimit != null ? ` / ${Math.round(d.powerLimit)} W` : d.power != null ? " W" : ""}
                      </strong>
                    </span>
                    <span>
                      {t("ssh.monitor.gpuFan")}
                      <strong>
                        {d.fanSpeed != null ? `${Math.round(d.fanSpeed)}%` : "—"}
                      </strong>
                    </span>
                  </div>
                  {!compact && <MonSparkline values={sparklines.gpu[i] ?? []} />}
                </div>
              );
            })}
          </div>
      </div>
      ) : null}
    </div>
  );
}

export function aggregateGpuPct(stats: HostSystemStats): number | null {
  return aggregateGpuUtilization(stats.gpu);
}
