import { memo, useEffect, useMemo, type ReactNode } from "react";
import { useDbWorkspaceActiveTab } from "../../../contexts/DbWorkspaceContext";
import { useDbDockLayoutStore } from "../../../stores/dbDockLayoutStore";
import { useDbWorkspaceActiveTabStore } from "../../../stores/dbWorkspaceActiveTabStore";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";
import { useDbSidebarLinkageStore } from "../../../stores/dbSidebarLinkageStore";
import {
  DEFAULT_STICKY_VISIT_MAX,
  ModuleSegmentDock,
  type DockableTab,
} from "../../../components/dock";
import { WorkspaceEmptyPage } from "../../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import { collectOpenTabNodeIds } from "../schema/resolveDbSidebarLinkage";
import {
  buildDatabasePanelContentKeysByTab,
  buildSqlTabPanelKeySeed,
  selectTablePreviewTabIdKey,
} from "./databasePanelTabKeys";
import type { DbWorkspaceTab } from "./workspaceTabs";

export interface DatabaseWorkspaceDockProps {
  workspaceInitialized: boolean;
  dockTabs: DockableTab[];
  /** 完整工作区 Tab（含 kind），供 content key / 侧栏「已打开」标记；勿用 dockTabs 替代 */
  workspaceTabs: DbWorkspaceTab[];
  connections: DbConnectionConfig[];
  onCloseTab: (tabId: string) => void;
  renderDockPanel: (tabId: string) => ReactNode;
  softRefreshKey?: string;
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
  /** 模块非 live：挂起业务内容（预热壳） */
  contentSuspended?: boolean;
}

/** 数据库模块右侧 Dock 工作区（表 / SQL / 设计器等 Tab）。 */
export const DatabaseWorkspaceDock = memo(function DatabaseWorkspaceDock({
  workspaceInitialized,
  dockTabs,
  workspaceTabs,
  connections,
  onCloseTab,
  renderDockPanel,
  softRefreshKey,
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
  contentSuspended = false,
}: DatabaseWorkspaceDockProps) {
  const { t } = useI18n();
  const { activeTabId, setActiveTabId } = useDbWorkspaceActiveTab();
  // 布局订阅放在 Dock 内：切 Tab 写 layout 时不要拖垮 DatabasePanel（侧栏/整页）
  const dockLayout = useDbDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useDbDockLayoutStore((s) => s.setSavedLayout);

  // content key / openTab 标记放在 Dock：SQL 切库、表预览增删时不要拖垮 DatabasePanel model
  const sqlTabPanelKeySeed = useDbWorkspaceTabStore((state) =>
    buildSqlTabPanelKeySeed(workspaceTabs, state),
  );
  const tablePreviewTabIdKey = useMemo(
    () => selectTablePreviewTabIdKey(useDbWorkspaceTabStore.getState(), workspaceTabs),
    [workspaceTabs],
  );

  const panelContentKeysByTab = useMemo(() => {
    const tabState = useDbWorkspaceTabStore.getState();
    return buildDatabasePanelContentKeysByTab({
      workspaceTabs,
      sqlTabStates: tabState.sqlTabStates,
      tablePreviews: tabState.tablePreviews,
      tableDesignerStates: {},
      connections,
    });
  }, [workspaceTabs, connections, sqlTabPanelKeySeed, tablePreviewTabIdKey]);

  useEffect(() => {
    const tabState = useDbWorkspaceTabStore.getState();
    const ids = collectOpenTabNodeIds(workspaceTabs, {
      sqlTabStates: tabState.sqlTabStates,
      tablePreviews: tabState.tablePreviews,
    });
    useDbSidebarLinkageStore.getState().setOpenTabNodeIds(ids);
  }, [workspaceTabs, sqlTabPanelKeySeed, tablePreviewTabIdKey]);

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
      // 懒创建 + 访问后粘住（未访问不挂 Monaco；已访问切回不闪）
      stickyVisit
      stickyVisitMax={DEFAULT_STICKY_VISIT_MAX}
      contentSuspended={contentSuspended}
      // 侧栏连接树联动：下一帧通知（先让乐观 Tab 高亮画出来）
      deferActiveTabNotify={false}
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={setActiveTabId}
      onActiveTabPreview={(tabId) => {
        // pointerdown 同步写入，避免 dock 先露出面板时内容仍按旧 active 藏起来
        useDbWorkspaceActiveTabStore.getState().setActiveTabId(tabId);
      }}
      onGroupsActiveTabIdsChange={(ids) => {
        // 分屏后每个 group 各有一个 active panel：都要算「可见」，
        // 否则非聚焦那一侧会被 display:none 成空白，聚焦后才恢复
        useDbWorkspaceActiveTabStore.getState().setGroupActiveTabIds(ids);
      }}
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
