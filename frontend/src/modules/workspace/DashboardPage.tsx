import { useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceSwitcher } from "../../components/shell/WorkspaceSwitcher";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { DASHBOARD_PATH } from "../../lib/paths";
import { quickInput } from "../../lib/quickInput";
import { useI18n } from "../../i18n";
import { HomeBoardView } from "./HomeBoardView";
import { HomeCustomPanelView } from "./HomeCustomPanelView";
import {
  CREATE_CUSTOM_MENU_ID,
  HOME_DASHBOARD_PAGE_IDS,
  isHomeBuiltinPageId,
  isHomeCustomPanelId,
  isHomeDashboardTabId,
  useDashboardStore,
  type HomeDashboardTabId,
} from "./useDashboardStore";

function labelForBuiltinTab(t: (key: string) => string): string {
  return t("homeWorkspace.tabs.board");
}

/** 独立看板页：/dashboard — 可关闭 / 可新建内置页与自定义面板 */
export function DashboardPage() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === DASHBOARD_PATH;
  const activeTabId = useDashboardStore((s) => s.homeTabId);
  const openTabIds = useDashboardStore((s) => s.openTabIds);
  const customPanels = useDashboardStore((s) => s.customPanels);
  const setHomeTabId = useDashboardStore((s) => s.setHomeTabId);
  const openHomeTab = useDashboardStore((s) => s.openHomeTab);
  const createCustomPanel = useDashboardStore((s) => s.createCustomPanel);
  const renameCustomPanel = useDashboardStore((s) => s.renameCustomPanel);
  const closeHomeTab = useDashboardStore((s) => s.closeHomeTab);

  const labelForTab = useCallback(
    (tabId: HomeDashboardTabId) => {
      if (isHomeCustomPanelId(tabId)) {
        return customPanels[tabId]?.label ?? t("homeWorkspace.customPanel.defaultTitle");
      }
      return labelForBuiltinTab(t);
    },
    [customPanels, t],
  );

  const segmentTabs = useMemo(
    () =>
      openTabIds.map((id) => ({
        id,
        label: labelForTab(id),
        closable: true,
      })),
    [labelForTab, openTabIds],
  );

  const pageMenuItems = useMemo(
    () => [
      ...HOME_DASHBOARD_PAGE_IDS.map((id) => ({
        id,
        label: labelForBuiltinTab(t),
      })),
      {
        id: CREATE_CUSTOM_MENU_ID,
        label: t("homeWorkspace.customPanel.menuLabel"),
        dividerBefore: true,
      },
    ],
    [t],
  );

  const handleCreateCustomPanel = useCallback(() => {
    const index =
      Object.keys(useDashboardStore.getState().customPanels).length + 1;
    createCustomPanel(t("homeWorkspace.customPanel.untitled", { n: index }));
  }, [createCustomPanel, t]);

  const handleRenameCustomPanel = useCallback(
    async (tabId: string) => {
      if (!isHomeCustomPanelId(tabId)) return;
      const current =
        useDashboardStore.getState().customPanels[tabId]?.label ??
        t("homeWorkspace.customPanel.defaultTitle");
      const next = await quickInput({
        title: t("homeWorkspace.customPanel.renameTitle"),
        defaultValue: current,
        placeholder: t("homeWorkspace.customPanel.renamePlaceholder"),
        validate: (value) =>
          value.trim() ? null : t("homeWorkspace.customPanel.renameRequired"),
      });
      if (!next) return;
      renameCustomPanel(tabId, next.trim());
    },
    [renameCustomPanel, t],
  );

  const handleTabDoubleClick = useCallback(
    (tabId: string) => {
      void handleRenameCustomPanel(tabId);
    },
    [handleRenameCustomPanel],
  );

  const addTabConfig = useMemo(() => {
    if (!isActiveRoute) return undefined;
    return {
      show: true,
      title: t("homeWorkspace.newPage"),
      menuItems: pageMenuItems,
      onMenuSelect: (id: string) => {
        if (id === CREATE_CUSTOM_MENU_ID) {
          handleCreateCustomPanel();
          return;
        }
        if (isHomeBuiltinPageId(id)) openHomeTab(id);
      },
    };
  }, [handleCreateCustomPanel, isActiveRoute, openHomeTab, pageMenuItems, t]);

  const preActions = useMemo(
    () => <WorkspaceSwitcher placement="below" context="home" />,
    [],
  );

  const onActiveTabChange = useCallback(
    (tabId: string) => {
      if (isHomeDashboardTabId(tabId)) setHomeTabId(tabId);
    },
    [setHomeTabId],
  );

  const onCloseTab = useCallback(
    (tabId: string) => {
      if (isHomeDashboardTabId(tabId)) closeHomeTab(tabId);
    },
    [closeHomeTab],
  );

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === "board") {
      return (
        <div className="dashboard-page">
          <HomeBoardView />
        </div>
      );
    }
    if (isHomeCustomPanelId(tabId)) {
      return <HomeCustomPanelView panelId={tabId} />;
    }
    return null;
  }, []);

  const emptyQuickActions = useMemo(
    () => [
      ...HOME_DASHBOARD_PAGE_IDS.map((id) => ({
        id,
        label: labelForBuiltinTab(t),
        onClick: () => openHomeTab(id),
      })),
      {
        id: CREATE_CUSTOM_MENU_ID,
        label: t("homeWorkspace.customPanel.menuLabel"),
        onClick: handleCreateCustomPanel,
      },
    ],
    [handleCreateCustomPanel, openHomeTab, t],
  );

  const resolvedActiveTabId =
    openTabIds.length === 0
      ? ""
      : openTabIds.includes(activeTabId)
        ? activeTabId
        : openTabIds[0];

  return (
    <ModuleSegmentDock
      className="dashboard-module-dock"
      dockScope="dashboard"
      tabs={segmentTabs}
      activeTabId={resolvedActiveTabId}
      onActiveTabChange={onActiveTabChange}
      onCloseTab={onCloseTab}
      onTabDoubleClick={handleTabDoubleClick}
      // 顶栏承载窗口控制，绝不能因路由抖动打上 route-inactive。
      // 「+」菜单已由 addTabConfig 按 isActiveRoute 自行开关。
      enabled={true}
      preActions={preActions}
      addTabConfig={addTabConfig}
      renderPanel={renderPanel}
      emptyContent={
        <WorkspaceEmptyPage
          title={t("routes.dashboard")}
          prompt={t("homeWorkspace.emptyPrompt")}
          actionList={{
            title: t("homeWorkspace.newPage"),
            items: emptyQuickActions,
          }}
        />
      }
    />
  );
}
