import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../../components/dock";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";

export interface ServerWorkspaceDockProps {
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

/** 服务器模块右侧 Dock 工作区（面板 Tab）。 */
/** @deprecated 已改用 ModuleSegmentDock */
export function ServerWorkspaceDock({
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
}: ServerWorkspaceDockProps) {
  const { t } = useI18n();

  return (
    <DockableWorkspace
      className="server-workspace-dock"
      dockScope="server"
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
      emptyContent={<WorkspaceEmptyPage title={t("routes.server")} prompt={emptyPrompt} />}
    />
  );
}
