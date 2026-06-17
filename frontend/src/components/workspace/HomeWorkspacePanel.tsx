import { useCallback, useMemo } from "react";
import { ModuleSegmentDock } from "../dock";
import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { AiPanelBody } from "../ai/AiDrawer";
import { HomeBoardView } from "../../modules/workspace/HomeBoardView";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { useI18n } from "../../i18n";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";

const HOME_TABS = ["board", "ai"] as const;
type HomeTab = (typeof HOME_TABS)[number];

/**
 * 首页特殊工作区：固定「看板 + AI 助手」两个 Tab，不可添加/关闭/拖入外部面板。
 * 与可自定义 Tab 的工程工作区（WorkspacePanel）完全独立。
 */
export function HomeWorkspacePanel() {
  const { t } = useI18n();
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const [activeTab, setActiveTab] = usePersistedModuleTab<HomeTab>(
    "home-workspace",
    "board",
    HOME_TABS,
  );

  const segmentTabs = useMemo(
    () => [
      { id: "board", label: t("homeWorkspace.tabs.board"), closable: false },
      { id: "ai", label: t("homeWorkspace.tabs.ai"), closable: false },
    ],
    [t],
  );

  const preActions = useMemo(
    () => <WorkspaceSwitcher placement="below" />,
    [],
  );

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === "board") {
      return <HomeBoardView />;
    }
    if (tabId === "ai") {
      return (
        <div className="home-workspace-ai-pane">
          <AiPanelBody />
        </div>
      );
    }
    return null;
  }, []);

  return (
    <ModuleSegmentDock
      className="home-workspace-panel"
      dockScope="home-workspace"
      tabs={segmentTabs}
      activeTabId={activeTab}
      onActiveTabChange={(id) => setActiveTab(id as HomeTab)}
      renderPanel={renderPanel}
      preActions={preActions}
      windowControl={isFullscreen}
    />
  );
}
