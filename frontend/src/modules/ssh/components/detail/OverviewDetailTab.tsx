import { useSshOverview } from "../../hooks/useSshOverview";
import { formatBytes } from "../../../../stores/sshStatsStore";
import { useI18n } from "../../../../i18n";
import { useState } from "react";
import type { SshProcessInfo } from "../../../../ipc/bindings";
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

type SortKey = keyof SshProcessInfo;
const PAGE_SIZE = 20;

type ProcessListPanelProps = {
  processes: SshProcessInfo[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

function ProcessListPanel({ processes, loading, error, onRefresh }: ProcessListPanelProps) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);

  const sorted = [...processes].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") return sortDir * (av - bv);
    const avs = av == null ? "" : String(av);
    const bvs = bv == null ? "" : String(bv);
    return sortDir * avs.localeCompare(bvs);
  });

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "cpu" || key === "mem" ? -1 : 1);
    }
    setPage(0);
  }

  function SortIndicator({ col }: { col: SortKey }) {
    if (col !== sortKey) return <span className="proc-sort-arrow">↕</span>;
    return <span className="proc-sort-arrow proc-sort-active">{sortDir === -1 ? "↓" : "↑"}</span>;
  }

  const columns: { key: SortKey; label: string; align?: string }[] = [
    { key: "user", label: t("ssh.processList.user") },
    { key: "pid", label: t("ssh.processList.pid"), align: "right" },
    { key: "cpu", label: t("ssh.processList.cpu"), align: "right" },
    { key: "mem", label: t("ssh.processList.mem"), align: "right" },
    { key: "vsz", label: t("ssh.processList.vsz"), align: "right" },
    { key: "rss", label: t("ssh.processList.rss"), align: "right" },
    { key: "stat", label: t("ssh.processList.stat") },
    { key: "start", label: t("ssh.processList.start") },
    { key: "time", label: t("ssh.processList.time") },
    { key: "command", label: t("ssh.processList.command") },
  ];

  return (
    <div className="proc-panel">
      <div className="proc-header">
        <span className="proc-title">{t("ssh.processList.title")}</span>
        <button className="proc-refresh" onClick={onRefresh} disabled={loading}>
          {loading ? "⟳" : "↻"}
        </button>
      </div>
      {error && <div className="proc-error">{error}</div>}
      {paged.length === 0 && !loading && !error && (
        <div className="proc-empty">{t("ssh.processList.empty")}</div>
      )}
      <div className="proc-table-wrap">
        <table className="proc-table">
          <thead>
            <tr>
              {columns.map(c => (
                <th
                  key={c.key}
                  className={c.align === "right" ? "proc-cell-right" : undefined}
                  onClick={() => handleSort(c.key)}
                >
                  {c.label} <SortIndicator col={c.key} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map(p => (
              <tr key={p.pid}>
                <td>{p.user}</td>
                <td className="proc-cell-right">{p.pid}</td>
                <td className="proc-cell-right">{p.cpu?.toFixed(1) ?? "—"}</td>
                <td className="proc-cell-right">{p.mem?.toFixed(1) ?? "—"}</td>
                <td className="proc-cell-right">{p.vsz != null ? formatBytes(p.vsz) : "—"}</td>
                <td className="proc-cell-right">{p.rss != null ? formatBytes(p.rss * 1024) : "—"}</td>
                <td>{p.stat}</td>
                <td>{p.start}</td>
                <td>{p.time}</td>
                <td className="proc-cell-cmd" title={p.command}>{p.command}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="proc-pager">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</button>
          <span>{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>›</button>
        </div>
      )}
    </div>
  );
}

export function OverviewDetailTab({
  profile,
  activeResource,
}: Props) {
  const { t } = useI18n();
  const resourceId = activeResource?.id ?? null;
  const { phase, stats, processes, error, refresh } = useSshOverview(resourceId);

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

  if (phase === "loading" || phase === "idle") {
    return (
      <div className="ssh-ov ssh-ov--loading">
        <div className="ssh-ov-loading">
          <span className="ssh-ov-loading-spinner" aria-hidden />
          <p>{t("ssh.overview.loading")}</p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="ssh-ov ssh-ov--error">
        <div className="ssh-ov-loading">
          <p className="ssh-ov-error-text">{error ?? t("ssh.overview.loadError")}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => refresh()}>
            {t("ssh.overview.retry")}
          </button>
        </div>
      </div>
    );
  }

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
      <ProcessListPanel
        processes={processes}
        loading={false}
        error={null}
        onRefresh={refresh}
      />
    </div>
  );
}
