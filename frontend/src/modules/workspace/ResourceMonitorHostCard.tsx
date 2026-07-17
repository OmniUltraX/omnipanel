import { useCallback, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { navigateToFeature } from "../../lib/workspaceNavigation";
import type { OverviewPhase } from "../../stores/sshHostStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { MonitoringDashboard } from "../server/ssh/components/monitoring/MonitoringDashboard";
import { disableSshMonitoring } from "../server/ssh/hooks/useSshMonitoring";
import type { ActiveMonitoringHost } from "./useActiveMonitoringHosts";

type Props = {
  host: ActiveMonitoringHost;
};

export function ResourceMonitorHostCard({ host }: Props) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const phase: OverviewPhase = host.stats ? "ready" : "loading";
  const updatedAt =
    host.updatedAt ??
    (host.stats?.timestamp != null ? host.stats.timestamp * 1000 : null);

  const openHost = useCallback(() => {
    useWorkspaceStore.getState().selectResource(host.resourceId, host.path);
    navigateToFeature(host.path, navigate);
  }, [host.path, host.resourceId, navigate]);

  const onDisable = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      void disableSshMonitoring(host.resourceId);
    },
    [host.resourceId],
  );

  return (
    <article className="resource-monitor-host-card">
      <header className="resource-monitor-host-card__header">
        <button
          type="button"
          className="resource-monitor-host-card__identity"
          onClick={openHost}
        >
          <span className="resource-monitor-host-card__live" aria-hidden />
          <span className="resource-monitor-host-card__name">{host.name}</span>
          {host.address ? (
            <span className="resource-monitor-host-card__addr">{host.address}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="resource-monitor-host-card__stop"
          onClick={onDisable}
          title={t("dashboard.resourceMonitor.disable")}
        >
          {t("dashboard.resourceMonitor.disable")}
        </button>
      </header>
      <div className="resource-monitor-host-card__body">
        <MonitoringDashboard
          phase={phase}
          stats={host.stats}
          error={null}
          hostLabel={host.name}
          hostAddress={host.address || undefined}
          updatedAt={updatedAt}
          compact
          hideStatusBar
          loadingMessage={t("ssh.monitoring.loading")}
        />
      </div>
    </article>
  );
}
