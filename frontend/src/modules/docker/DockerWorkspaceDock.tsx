import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";

export interface DockerWorkspaceDockProps {
  dockTabs: DockableTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  onTabDoubleClick?: (tabId: string) => void;
  panelContentKey?: string;
  emptyPrompt: string;
}

/** Docker 模块右侧 Dock 工作区（连接 Tab）。 */
export function DockerWorkspaceDock({
  dockTabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderDockPanel,
  onTabDoubleClick,
  panelContentKey,
  emptyPrompt,
}: DockerWorkspaceDockProps) {
  const { t } = useI18n();

  return (
    <DockableWorkspace
      className="docker-workspace-dock"
      dockScope="docker"
      defaultHeaderPosition="top"
      enableTabGroups={false}
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={onActiveTabChange}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={onDockLayoutChange}
      renderPanel={renderDockPanel}
      onTabDoubleClick={onTabDoubleClick}
      panelContentKey={panelContentKey}
      windowControl={false}
      emptyContent={<WorkspaceEmptyPage title={t("routes.docker")} prompt={emptyPrompt} />}
    />
  );
}
