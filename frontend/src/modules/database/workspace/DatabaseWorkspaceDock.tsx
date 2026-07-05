import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { useDbWorkspaceActiveTab } from "../../../contexts/DbWorkspaceContext";
import { ModuleSegmentDock, type DockableTab } from "../../../components/dock";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";

export interface DatabaseWorkspaceDockProps {
  workspaceInitialized: boolean;
  dockTabs: DockableTab[];
  onCloseTab: (tabId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  softRefreshKey?: string;
  panelContentKeysByTab?: Record<string, string>;
  onTabContextMenu: (event: React.MouseEvent, tabId: string, index: number) => void;
  onTabDoubleClick?: (tabId: string) => void;
  recentClosedActionItems: Array<{ id: string; label: string; meta: string; onClick: () => void }>;
  emptyPrompt: string;
  recentClosedTitle: string;
  moduleTitle?: ReactNode;
  enabled?: boolean;
  windowControl?: boolean;
}

/** 数据库模块右侧 Dock 工作区（表 / SQL / 设计器等 Tab）。 */
export function DatabaseWorkspaceDock({
  workspaceInitialized,
  dockTabs,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderDockPanel,
  softRefreshKey,
  panelContentKeysByTab,
  onTabContextMenu,
  onTabDoubleClick,
  recentClosedActionItems,
  emptyPrompt,
  recentClosedTitle,
  moduleTitle,
  enabled = true,
  windowControl = true,
}: DatabaseWorkspaceDockProps) {
  const { t } = useI18n();
  const { activeTabId, setActiveTabId } = useDbWorkspaceActiveTab();

  if (!workspaceInitialized) {
    return null;
  }

  return (
    <ModuleSegmentDock
      className="db-workspace db-module-dock"
      variant="workspace"
      dockScope="database"
      moduleTitle={moduleTitle}
      enabled={enabled}
      windowControl={windowControl}
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={setActiveTabId}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={onDockLayoutChange}
      renderPanel={renderDockPanel}
      softRefreshKey={softRefreshKey}
      panelContentKeysByTab={panelContentKeysByTab}
      onTabContextMenu={onTabContextMenu}
      onTabDoubleClick={onTabDoubleClick}
      emptyContent={
        <WorkspaceEmptyPage
          title={t("routes.database")}
          prompt={emptyPrompt}
          actionList={
            recentClosedActionItems.length > 0
              ? {
                  title: recentClosedTitle,
                  items: recentClosedActionItems,
                }
              : undefined
          }
        />
      }
    />
  );
}
