import type { ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../../components/dock";
import { WorkspaceEmptyPage } from "../../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";

export interface SshWorkspaceDockProps {
  dockTabs: DockableTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  onTabDoubleClick?: (tabId: string) => void;
  emptyPrompt: string;
}

/** SSH 模块右侧 Dock 工作区（主机详情 Tab）。 */
export function SshWorkspaceDock({
  dockTabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderDockPanel,
  onTabDoubleClick,
  emptyPrompt,
}: SshWorkspaceDockProps) {
  const { t } = useI18n();

  return (
    <DockableWorkspace
      className="ssh-workspace"
      dockScope="ssh"
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
      windowControl={false}
      emptyContent={<WorkspaceEmptyPage title={t("routes.ssh")} prompt={emptyPrompt} />}
    />
  );
}
