import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";

export interface FilesWorkspaceDockProps {
  dockTabs: DockableTab[];
  activePanelId: string | null;
  onActivePanelChange: (panelId: string) => void;
  onCloseTab: (panelId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderPanel: (panelId: string) => ReactNode;
  softRefreshKey?: string;
}

/** @deprecated 已改用 ModuleSegmentDock；连接级多 Tab 已移除 */
export function FilesWorkspaceDock({
  dockTabs,
  activePanelId,
  onActivePanelChange,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderPanel,
  softRefreshKey,
}: FilesWorkspaceDockProps) {
  const { t } = useI18n();

  return (
    <DockableWorkspace
      className="fm-dock-workspace fm-workspace"
      dockScope="files-browser"
      defaultHeaderPosition="top"
      enableTabGroups={false}
      tabs={dockTabs}
      activeTabId={activePanelId ?? ""}
      onActiveTabChange={onActivePanelChange}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={onDockLayoutChange}
      renderPanel={renderPanel}
      softRefreshKey={softRefreshKey}
      windowControl={false}
      emptyContent={
        <WorkspaceEmptyPage
          title={t("routes.files")}
          prompt={t("files.workspace.emptyTabs")}
        />
      }
    />
  );
}
