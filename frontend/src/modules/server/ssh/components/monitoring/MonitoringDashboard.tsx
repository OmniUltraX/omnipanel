import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/primitives/Button";
import { useI18n } from "@/i18n";
import type { OverviewPhase } from "@/modules/server/ssh/hooks/useSshOverview";
import type { HostSystemStats } from "@/stores/sshStatsStore";
import { MonMetricCards } from "./MonMetricCards";
import { MonNetStrip } from "./MonNetStrip";
import { MonStatusBar } from "./MonStatusBar";
import { computeByteRate } from "./monitoringUtils";
import { useMonitorSparklines } from "./useMonitorSparklines";

export type MonitoringDashboardProps = {
  phase: OverviewPhase;
  stats: HostSystemStats | null;
  error: string | null;
  hostLabel?: string;
  hostAddress?: string;
  updatedAt?: number | null;
  refreshing?: boolean;
  processCount?: number;
  onRetry?: () => void;
  onRefresh?: () => void;
  compact?: boolean;
  /** 概览页已有顶栏信息时隐藏重复的状态条 */
  hideStatusBar?: boolean;
  loadingMessage?: string;
  children?: React.ReactNode;
};

export function MonitoringDashboard({
  phase,
  stats,
  error,
  hostLabel,
  hostAddress,
  updatedAt,
  refreshing = false,
  processCount = 0,
  onRetry,
  onRefresh,
  compact = false,
  hideStatusBar = false,
  loadingMessage,
  children,
}: MonitoringDashboardProps) {
  const { t } = useI18n();
  const prevStatsRef = useRef<HostSystemStats | null>(null);
  const sparklines = useMonitorSparklines(stats);

  useEffect(() => {
    if (stats) prevStatsRef.current = stats;
  }, [stats]);

  const prev = prevStatsRef.current;
  const netUpRate =
    stats && prev && prev !== stats
      ? computeByteRate(prev, stats, (s) => s.network?.txBytes)
      : null;
  const netDownRate =
    stats && prev && prev !== stats
      ? computeByteRate(prev, stats, (s) => s.network?.rxBytes)
      : null;
  const diskReadRate =
    stats && prev && prev !== stats
      ? computeByteRate(prev, stats, (s) => s.disk?.readBytes ?? null)
      : null;
  const diskWriteRate =
    stats && prev && prev !== stats
      ? computeByteRate(prev, stats, (s) => s.disk?.writeBytes ?? null)
      : null;

  const className = `mon-dashboard${compact ? " mon-dashboard--compact" : ""}`;
  const loadingText = loadingMessage ?? t("ssh.overview.loading");
  const hasStats = stats != null;
  const label = hostLabel ?? stats?.hostName ?? "—";

  if ((phase === "loading" || phase === "idle") && !hasStats) {
    return (
      <div className={className}>
        <div className="mon-loading">
          <span className="mon-loading-spinner" aria-hidden />
          <p>{loadingText}</p>
        </div>
      </div>
    );
  }

  if (phase === "error" && !hasStats) {
    return (
      <div className={className}>
        <div className="mon-error">
          <p className="mon-error-text">{error ?? t("ssh.overview.loadError")}</p>
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t("ssh.overview.retry")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className={className}>
      {!hideStatusBar && (
        <MonStatusBar
          hostLabel={label}
          hostAddress={hostAddress}
          uptimeSecs={stats.uptimeSecs}
          updatedAt={updatedAt}
          live={phase === "ready"}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
      <MonMetricCards
        stats={stats}
        sparklines={sparklines}
        diskReadRate={diskReadRate}
        diskWriteRate={diskWriteRate}
      />
      <MonNetStrip
        stats={stats}
        netUpRate={netUpRate}
        netDownRate={netDownRate}
        diskReadRate={diskReadRate}
        diskWriteRate={diskWriteRate}
        processCount={processCount}
      />
      {children}
    </div>
  );
}
