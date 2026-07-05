import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";

export interface KnowledgeWorkspaceDockProps {
  dockTabs: DockableTab[];
  activeTabId: string | null;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderPanel: (tabId: string) => ReactNode;
  onTabDoubleClick?: (tabId: string) => void;
}

/** @deprecated 已改用 ModuleSegmentDock */
export function KnowledgeWorkspaceDock({
  dockTabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderPanel,
  onTabDoubleClick,
}: KnowledgeWorkspaceDockProps) {
  const { t } = useI18n();

  return (
    <DockableWorkspace
      className="knowledge-workspace-dock"
      dockScope="knowledge"
      defaultHeaderPosition="top"
      enableTabGroups={false}
      tabs={dockTabs}
      activeTabId={activeTabId ?? ""}
      onActiveTabChange={onActiveTabChange}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={onDockLayoutChange}
      renderPanel={renderPanel}
      onTabDoubleClick={onTabDoubleClick}
      windowControl={false}
      emptyContent={
        <WorkspaceEmptyPage
          title={t("routes.knowledge")}
          prompt={t("knowledge.selectEntry")}
        />
      }
    />
  );
}
