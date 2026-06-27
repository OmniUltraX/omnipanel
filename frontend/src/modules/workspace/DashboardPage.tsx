import { useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceSwitcher } from "../../components/shell/WorkspaceSwitcher";
import { DASHBOARD_PATH } from "../../lib/paths";
import { useI18n } from "../../i18n";
import { HomeBoardView } from "./HomeBoardView";

const DASHBOARD_TAB_ID = "board";

/** 独立看板页：/dashboard */
export function DashboardPage() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === DASHBOARD_PATH;

  const segmentTabs = useMemo(
    () => [{ id: DASHBOARD_TAB_ID, label: t("routes.dashboard") }],
    [t],
  );

  const preActions = useMemo(() => <WorkspaceSwitcher placement="below" />, []);

  const renderPanel = useCallback((tabId: string) => {
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
      moduleTitle={t("routes.dashboard")}
      tabs={segmentTabs}
      activeTabId={DASHBOARD_TAB_ID}
      onActiveTabChange={() => {}}
      enabled={isActiveRoute}
      preActions={preActions}
      renderPanel={renderPanel}
    />
  );
}
