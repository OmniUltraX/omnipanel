import { useI18n } from "../../i18n";
import { ResourceMonitorHostCard } from "./ResourceMonitorHostCard";
import { useActiveMonitoringHosts } from "./useActiveMonitoringHosts";

/** 首页「资源监控」tab：展示所有已开启 SSH 系统监控的主机卡片 */
export function ResourceMonitorBoard() {
  const { t } = useI18n();
  const hosts = useActiveMonitoringHosts();

  return (
    <div className="resource-monitor-board">
      {hosts.length === 0 ? (
        <div className="resource-monitor-board__empty">
          <p className="resource-monitor-board__empty-title">
            {t("dashboard.resourceMonitor.emptyTitle")}
          </p>
          <p className="resource-monitor-board__empty-hint">
            {t("dashboard.resourceMonitor.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="resource-monitor-board__grid">
          {hosts.map((host) => (
            <ResourceMonitorHostCard key={host.resourceId} host={host} />
          ))}
        </div>
      )}
    </div>
  );
}
