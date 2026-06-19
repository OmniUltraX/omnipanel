import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceSwitcher } from "../../components/shell/WorkspaceSwitcher";
import { useI18n } from "../../i18n";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { isWorkspacePath } from "../../lib/paths";

type UserWorkspaceTab = "overview";
const USER_WORKSPACE_TABS: UserWorkspaceTab[] = ["overview"];

function WorkspaceOverviewView() {
  return <div className="user-workspace-overview" />;
}

/**
 * 用户工作区页面：/workspace/:workspaceId
 * 按 URL 参数切换工作区上下文，使用 ModuleSegmentDock 与模块页面布局一致。
 */
export function UserWorkspace() {
  const { t } = useI18n();
  const location = useLocation();
  const params = useParams<{ workspaceId: string }>();
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const isActiveRoute = isWorkspacePath(location.pathname);
  const [tab, setTab] = usePersistedModuleTab("user-workspace", "overview", USER_WORKSPACE_TABS);

  useEffect(() => {
    const id = params.workspaceId;
    if (id) switchWorkspace(id);
  }, [params.workspaceId, switchWorkspace]);

  const segmentTabs = useMemo(
    () => [{ id: "overview", label: t("workspace.detail.tabs.overview") }],
    [t],
  );

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === "overview") {
      return <WorkspaceOverviewView />;
    }
    return null;
  }, []);

  const preActions = useMemo(() => <WorkspaceSwitcher placement="below" />, []);

  return (
    <ModuleSegmentDock
      className="user-workspace-module-dock"
      tabs={segmentTabs}
      activeTabId={tab}
      onActiveTabChange={(id) => setTab(id as UserWorkspaceTab)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
      preActions={preActions}
    />
  );
}
