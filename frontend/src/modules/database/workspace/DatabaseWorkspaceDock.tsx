import { memo, type ReactNode } from "react";
import { useDbWorkspaceActiveTab } from "../../../contexts/DbWorkspaceContext";
import { useDbDockLayoutStore } from "../../../stores/dbDockLayoutStore";
import { ModuleSegmentDock, type DockableTab } from "../../../components/dock";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";

export interface DatabaseWorkspaceDockProps {
  workspaceInitialized: boolean;
  dockTabs: DockableTab[];
  onCloseTab: (tabId: string) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  softRefreshKey?: string;
  panelContentKeysByTab?: Record<string, string>;
  onTabContextMenu: (event: React.MouseEvent, tabId: string, index: number) => void;
  onTabDoubleClick?: (tabId: string) => void;
  onPanelTransferredOut?: (panelId: string, targetScope: string) => void;
  acceptExternalDrops?: boolean;
  recentClosedActionItems: Array<{ id: string; label: string; meta: string; onClick: () => void }>;
  emptyPrompt: string;
  recentClosedTitle: string;
  moduleTitle?: ReactNode;
  enabled?: boolean;
  windowControl?: boolean;
}

/** 数据库模块右侧 Dock 工作区（表 / SQL / 设计器等 Tab）。 */
export const DatabaseWorkspaceDock = memo(function DatabaseWorkspaceDock({
  workspaceInitialized,
  dockTabs,
  onCloseTab,
  renderDockPanel,
  softRefreshKey,
  panelContentKeysByTab,
  onTabContextMenu,
  onTabDoubleClick,
  onPanelTransferredOut,
  acceptExternalDrops = true,
  recentClosedActionItems,
  emptyPrompt,
  recentClosedTitle,
  moduleTitle,
  enabled = true,
  windowControl = true,
}: DatabaseWorkspaceDockProps) {
  const { t } = useI18n();
  const { activeTabId, setActiveTabId } = useDbWorkspaceActiveTab();
  // 布局订阅放在 Dock 内：切 Tab 写 layout 时不要拖垮 DatabasePanel（侧栏/整页）
  const dockLayout = useDbDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useDbDockLayoutStore((s) => s.setSavedLayout);

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
      // 常驻渲染：切 Tab 只切换可见性，避免 onlyWhenVisible 卸载/重挂造成「加载闪一下」
      defaultRenderer="always"
      // 侧栏连接树联动：下一帧通知（先让乐观 Tab 高亮画出来）
      deferActiveTabNotify={false}
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={setActiveTabId}
      onCloseTab={onCloseTab}
      savedLayout={dockLayout}
      onSavedLayoutChange={setDockLayout}
      renderPanel={renderDockPanel}
      softRefreshKey={softRefreshKey}
      panelContentKeysByTab={panelContentKeysByTab}
      onTabContextMenu={onTabContextMenu}
      onTabDoubleClick={onTabDoubleClick}
      onPanelTransferredOut={onPanelTransferredOut}
      acceptExternalDrops={acceptExternalDrops}
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
});
