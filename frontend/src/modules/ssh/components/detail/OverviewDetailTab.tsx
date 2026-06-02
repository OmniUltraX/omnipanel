import { useSshStats, formatBytes } from "../../../../stores/sshStatsStore";
import type { SshManagerContext } from "../../hooks/useSshManager";

type Props = Pick<
  SshManagerContext,
  "profile" | "activeResource"
>;

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

function usageColor(ratio: number): string {
  if (ratio >= 0.9) return "var(--danger)";
  if (ratio >= 0.7) return "var(--warn)";
  return "var(--success)";
}

function barStyle(ratio: number): React.CSSProperties {
  return {
    width: `${Math.min(ratio * 100, 100)}%`,
    background: usageColor(ratio),
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
  const color = usageColor(percent / 100);

  return (
    <div className="ssh-ov-card">
      <div className="ssh-ov-card-head">
        <div className="ssh-ov-card-icon" style={{ background: `color-mix(in oklch, ${accent} 14%, transparent)`, color: accent }}>
          {icon}
        </div>
        <span className="ssh-ov-card-label">{label}</span>
      </div>
      <div className="ssh-ov-card-pct" style={{ color }}>{value}</div>
      <div className="ssh-ov-card-bar">
        <div className="ssh-ov-card-bar-track">
          <div className="ssh-ov-card-bar-fill" style={barStyle(percent / 100)} />
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

export function OverviewDetailTab({
  profile,
  activeResource,
}: Props) {
  const stats = useSshStats(activeResource?.id ?? null);

  const cpuPct = stats ? Math.round(stats.cpuUsage) : 0;
  const memPct = stats
    ? Math.round((stats.memory.used / (stats.memory.total || 1)) * 100)
    : 0;
  const diskPct = stats
    ? Math.round((stats.disk.used / (stats.disk.total || 1)) * 100)
    : 0;

  const cpuDetails = stats
    ? [`${stats.cpuUsage.toFixed(1)}% 使用率 · ${stats.cpuCores} 核心`, `负载 ${stats.load}`]
    : [profile.cpu ?? "—"];
  const memDetails = stats
    ? [`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`, `${formatBytes(stats.memory.available)} 可用`]
    : [profile.memory ?? "—"];
  const diskDetails = stats
    ? [`${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`, `${formatBytes(stats.disk.available)} 可用`]
    : [profile.disk ?? "—"];

  return (
    <div className="ssh-ov">
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
          value={`${memPct}%`}
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
