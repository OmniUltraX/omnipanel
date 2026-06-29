import type { MouseEvent, ReactNode } from "react";
import type { SerializedDockview } from "dockview-core";
import { DockableWorkspace, type DockableTab } from "../../components/dock";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";

export interface ProtocolHttpWorkspaceDockProps {
  dockTabs: DockableTab[];
  activeTabId: string | null;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  dockLayout: SerializedDockview | null;
  onDockLayoutChange: (layout: SerializedDockview | null) => void;
  renderPanel: (tabId: string) => ReactNode;
  recentClosedActionItems: Array<{ id: string; label: string; meta: string; onClick: () => void }>;
  onTabContextMenu?: (event: MouseEvent, tabId: string, index: number) => void;
  onTabDoubleClick?: (tabId: string) => void;
}

/** HTTP 协议实验室右侧 Dock：每个已保存请求一个可关闭 Tab（Postman 风格）。 */
export function ProtocolHttpWorkspaceDock({
  dockTabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  dockLayout,
  onDockLayoutChange,
  renderPanel,
  recentClosedActionItems,
  onTabContextMenu,
  onTabDoubleClick,
}: ProtocolHttpWorkspaceDockProps) {
  const { t } = useI18n();

  return (
    <DockableWorkspace
      className="protocol-workspace dock-workspace"
      dockScope="protocol-http"
      defaultHeaderPosition="top"
      enableTabGroups={false}
      tabs={dockTabs}
      activeTabId={activeTabId ?? ""}
      onActiveTabChange={onActiveTabChange}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={onDockLayoutChange}
      renderPanel={renderPanel}
      onTabContextMenu={onTabContextMenu}
      onTabDoubleClick={onTabDoubleClick}
      windowControl={false}
      emptyContent={
        <WorkspaceEmptyPage
          title={t("protocol.tabs.http")}
          prompt={t("protocol.http.workspaceEmpty")}
          actionList={
            recentClosedActionItems.length > 0
              ? {
                  title: t("protocol.http.recentClosed"),
                  items: recentClosedActionItems,
                }
              : undefined
          }
        />
      }
    />
  );
}
