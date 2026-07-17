import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceSwitcher } from "../../components/shell/WorkspaceSwitcher";
import { DASHBOARD_PATH } from "../../lib/paths";
import { useI18n } from "../../i18n";
import { HomeBoardView } from "./HomeBoardView";
import { ResourceMonitorBoard } from "./ResourceMonitorBoard";

const DASHBOARD_TAB_ID = "board";
const RESOURCE_MONITOR_TAB_ID = "resource-monitor";

/** 独立看板页：/dashboard — 看板 | 资源监控 */
export function DashboardPage() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === DASHBOARD_PATH;
  const [activeTabId, setActiveTabId] = useState(DASHBOARD_TAB_ID);

  const segmentTabs = useMemo(
    () => [
      { id: DASHBOARD_TAB_ID, label: t("homeWorkspace.tabs.board") },
      { id: RESOURCE_MONITOR_TAB_ID, label: t("dashboard.resourceMonitor.tab") },
    ],
    [t],
  );

  const preActions = useMemo(() => <WorkspaceSwitcher placement="below" context="home" />, []);

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === RESOURCE_MONITOR_TAB_ID) {
      return (
        <div className="dashboard-page dashboard-page--resource-monitor">
          <ResourceMonitorBoard />
        </div>
      );
    }
    if (tabId !== DASHBOARD_TAB_ID) return null;
    return (
      <div className="dashboard-page">
        <HomeBoardView />
      </div>
    );
  }, []);

  return (
    <ModuleSegmentDock
      className="dashboard-module-dock"
      dockScope="dashboard"
      tabs={segmentTabs}
      activeTabId={activeTabId}
      onActiveTabChange={setActiveTabId}
      enabled={isActiveRoute}
      preActions={preActions}
      renderPanel={renderPanel}
    />
  );
}
