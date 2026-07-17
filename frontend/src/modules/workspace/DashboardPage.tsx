import { useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceSwitcher } from "../../components/shell/WorkspaceSwitcher";
import { DASHBOARD_PATH } from "../../lib/paths";
import { useI18n } from "../../i18n";
import { HomeBoardView } from "./HomeBoardView";
import { ResourceMonitorBoard } from "./ResourceMonitorBoard";
import { useDashboardStore } from "./useDashboardStore";

const DASHBOARD_TAB_ID = "board";
const RESOURCE_MONITOR_TAB_ID = "resource-monitor";

const HOME_TABS = new Set([DASHBOARD_TAB_ID, RESOURCE_MONITOR_TAB_ID]);

function isHomeTab(id: string): id is typeof DASHBOARD_TAB_ID | typeof RESOURCE_MONITOR_TAB_ID {
  return HOME_TABS.has(id);
}

/** 独立看板页：/dashboard — 看板 | 资源监控（tab 记忆） */
export function DashboardPage() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === DASHBOARD_PATH;
  const activeTabId = useDashboardStore((s) => s.homeTabId);
  const setHomeTabId = useDashboardStore((s) => s.setHomeTabId);

  const segmentTabs = useMemo(
    () => [
      { id: DASHBOARD_TAB_ID, label: t("homeWorkspace.tabs.board") },
      { id: RESOURCE_MONITOR_TAB_ID, label: t("dashboard.resourceMonitor.tab") },
    ],
    [t],
  );

  const preActions = useMemo(() => <WorkspaceSwitcher placement="below" context="home" />, []);

  const onActiveTabChange = useCallback(
    (tabId: string) => {
      if (isHomeTab(tabId)) setHomeTabId(tabId);
    },
    [setHomeTabId],
  );

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
      activeTabId={isHomeTab(activeTabId) ? activeTabId : DASHBOARD_TAB_ID}
      onActiveTabChange={onActiveTabChange}
      enabled={isActiveRoute}
      preActions={preActions}
      renderPanel={renderPanel}
    />
  );
}
