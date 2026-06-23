import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";

export interface DatabaseWorkspaceDockProps {
  workspaceInitialized: boolean;
  dockTabs: DockableTab[];
  activeWorkspaceTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  panelContentKeysByTab: Record<string, string>;
  onTabContextMenu: (event: React.MouseEvent, tabId: string, index: number) => void;
  onCtrlCopyTab: (tabId: string) => void;
  recentClosedActionItems: Array<{ id: string; label: string; meta: string; onClick: () => void }>;
  emptyPrompt: string;
  recentClosedTitle: string;
}

/** 数据库模块右侧 Dock 工作区（表 / SQL / 设计器等 Tab）。 */
export function DatabaseWorkspaceDock({
  workspaceInitialized,
  dockTabs,
  activeWorkspaceTabId,
  onActiveTabChange,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderDockPanel,
  panelContentKeysByTab,
  onTabContextMenu,
  onCtrlCopyTab,
  recentClosedActionItems,
  emptyPrompt,
  recentClosedTitle,
}: DatabaseWorkspaceDockProps) {
  if (!workspaceInitialized) {
    return null;
  }

  if (dockTabs.length === 0) {
    return (
      <WorkspaceEmptyPage
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
    );
  }

  return (
    <DockableWorkspace
      className="db-workspace"
      dockScope="database"
      defaultHeaderPosition="top"
      enableTabGroups={false}
      tabs={dockTabs}
      activeTabId={activeWorkspaceTabId}
      onActiveTabChange={onActiveTabChange}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={onDockLayoutChange}
      renderPanel={renderDockPanel}
      panelContentKeysByTab={panelContentKeysByTab}
      onTabContextMenu={onTabContextMenu}
      onCtrlCopyTab={onCtrlCopyTab}
      windowControl={false}
    />
  );
}
