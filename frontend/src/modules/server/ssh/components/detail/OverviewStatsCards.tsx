import { Button } from "../../../../../components/ui/Button";
import { useI18n } from "../../../../../i18n";
import {
  formatBytes,
  formatUsageBytes,
  safePercent,
  type HostSystemStats,
} from "../../../../../stores/sshStatsStore";
import type { OverviewPhase } from "../../hooks/useSshOverview";

function CpuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 9h6v6H9z" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M6 2v2M6 20v2M18 2v2M18 20v2" strokeWidth="1" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <rect x="5" y="9" width="3" height="6" rx="0.5" />
      <rect x="10.5" y="9" width="3" height="6" rx="0.5" />
      <rect x="16" y="9" width="3" height="6" rx="0.5" />
      <path d="M2 10h2M2 14h2M20 10h2M20 14h2" strokeWidth="1" />
    </svg>
  );
}

function DiskIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" />
      <path d="M12 22a10 10 0 0 1-10-10h3a7 7 0 0 0 7 7v3z" />
    </svg>
  );
}

function barStyle(ratio: number, accent: string): React.CSSProperties {
  return {
    width: `${Math.min(ratio * 100, 100)}%`,
    background: accent,
  };
}

type StatCardProps = {
  label: string;
  icon: React.ReactNode;
  percent: number;
  value: string;
  details: string[];
  accent: string;
};

function StatCard({ label, icon, percent, value, details, accent }: StatCardProps) {
  const pctColor =
    percent >= 90 ? "var(--danger)" : percent >= 70 ? "var(--warn)" : accent;

  return (
    <div className="ssh-ov-card">
      <div className="ssh-ov-card-head">
        <div className="ssh-ov-card-icon" style={{ background: `color-mix(in oklch, ${accent} 14%, transparent)`, color: accent }}>
          {icon}
        </div>
        <span className="ssh-ov-card-label">{label}</span>
      </div>
      <div className="ssh-ov-card-pct" style={{ color: pctColor }}>{value}</div>
      <div className="ssh-ov-card-bar">
        <div className="ssh-ov-card-bar-track">
          <div className="ssh-ov-card-bar-fill" style={barStyle(percent / 100, accent)} />
        </div>
      </div>
      <ul className="ssh-ov-card-details">
        {details.map((d, i) => (
          <li key={i}><span>{d}</span></li>
        ))}
      </ul>
    </div>
  );
}

export type OverviewStatsFallback = {
  cpu?: string;
  memory?: string;
  disk?: string;
};

export type OverviewStatsCardsProps = {
  phase: OverviewPhase;
  stats: HostSystemStats | null;
  error: string | null;
  fallback?: OverviewStatsFallback;
  onRetry?: () => void;
  compact?: boolean;
  /** 嵌入侧栏（如 SFTP 上方），加载态不占满整块区域 */
  embedded?: boolean;
};

export function OverviewStatsCards({
  phase,
  stats,
  error,
  fallback,
  onRetry,
  compact = false,
  embedded = false,
}: OverviewStatsCardsProps) {
  const { t } = useI18n();

  const cpuPct = stats ? Math.round(stats.cpuUsage ?? 0) : 0;
  const memPct = stats
    ? safePercent(stats.memory.used, stats.memory.total)
    : 0;
  const diskPct = stats
    ? safePercent(stats.disk.used, stats.disk.total)
    : 0;

  const cpuDetails = stats
    ? [`${(stats.cpuUsage ?? 0).toFixed(1)}% 使用率 · ${stats.cpuCores} 核心`, `负载 ${stats.load}`]
    : [fallback?.cpu ?? "—"];
  const memDetails = stats
    ? [
        formatUsageBytes(stats.memory.used, stats.memory.total),
        stats.memory.total && stats.memory.total > 0
          ? `${formatBytes(stats.memory.available)} 可用`
          : "—",
      ]
    : [fallback?.memory ?? "—"];
  const diskDetails = stats
    ? [
        formatUsageBytes(stats.disk.used, stats.disk.total),
        stats.disk.total && stats.disk.total > 0
          ? `${formatBytes(stats.disk.available)} 可用`
          : "—",
      ]
    : [fallback?.disk ?? "—"];

  const hasCachedStats = stats != null;

  const classSuffix = [
    compact ? " ssh-ov--compact" : "",
    embedded ? " ssh-ov--embedded" : "",
  ].join("");

  if ((phase === "loading" || phase === "idle") && !hasCachedStats) {
    return (
      <div className={`ssh-ov ssh-ov--loading${classSuffix}`}>
        <div className="ssh-ov-loading">
          <span className="ssh-ov-loading-spinner" aria-hidden />
          <p>{t("ssh.overview.loading")}</p>
        </div>
      </div>
    );
  }

  if (phase === "error" && !hasCachedStats) {
    return (
      <div className={`ssh-ov ssh-ov--error${classSuffix}`}>
        <div className="ssh-ov-loading">
          <p className="ssh-ov-error-text">{error ?? t("ssh.overview.loadError")}</p>
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t("ssh.overview.retry")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`ssh-ov${classSuffix}`}>
      <div className="ssh-ov-cards">
        <StatCard
          label="CPU"
          icon={<CpuIcon />}
          percent={cpuPct}
          value={`${cpuPct}%`}
          details={cpuDetails}
          accent="var(--accent)"
        />
        <StatCard
          label="Memory"
          icon={<MemoryIcon />}
          percent={memPct}
          value={
            stats?.memory.total && stats.memory.total > 0 ? `${memPct}%` : "—"
          }
          details={memDetails}
          accent="var(--success)"
        />
        <StatCard
          label="Disk"
          icon={<DiskIcon />}
          percent={diskPct}
          value={`${diskPct}%`}
          details={diskDetails}
          accent="var(--warn)"
        />
      </div>
    </div>
  );
}
