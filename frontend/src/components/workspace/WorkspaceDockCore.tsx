import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DockableWorkspace,
  createInitialDockTabVisited,
  markDockTabVisited,
  shouldMountDockTabContent,
} from "../dock";
import { requestDockScopeResync, subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import {
  resolveWorkspaceActiveTabId,
  resolveWorkspaceDockPanelType,
  resolveWorkspaceTabs,
  buildDefaultWorkspaceLayout,
  useWorkspaceBottomDockStore,
  type WorkspaceDockTab,
} from "../../stores/workspaceBottomDockStore";
import { isWorkspaceBuiltinTabId } from "../../lib/workspaceBuiltinPanels";
import { isLayoutUsable, collectPanelIds, mergePanelsIntoLayout } from "../dock/dockViewLayout";
import { syncWorkspaceDockActiveTabSideEffects } from "../../lib/syncWorkspaceDockActiveTab";
import { cleanupWorkspaceDockTab } from "../../lib/workspaceTabActions";
import {
  applyModuleTransferToWorkspace,
  isModuleDockScope,
} from "../../lib/moduleToWorkspaceTransfer";
import { moveWorkspaceTabToMain } from "../../lib/crossWindowDockTransfer";
import { deliverSnapshotToWorkspace } from "../../lib/workspaceSnapshotDelivery";
import { ContextMenu, type ContextMenuItem } from "../ui/menu/ContextMenu";
import { buildTabBulkCloseSubmenuItems } from "../ui/menu/contextMenuItems";
import { useI18n } from "../../i18n";
import { WorkspaceDockTabPanel } from "./WorkspaceDockTabPanel";

export interface WorkspaceDockCoreProps {
  workspace: WorkspaceInfo;
  dockScope: string;
  className?: string;
  preActions?: ReactNode;
  acceptExternalDrops?: boolean;
  tabStyle?: "topbar" | "segment";
  windowControl?: boolean;
  windowChromeVariant?: "segment" | "default";
  windowChromeLeftActions?: ReactNode;
  emptyContent?: ReactNode;
  /** 首页预热：不渲染 panel 内容，仅恢复 dock 布局结构 */
  contentSuspended?: boolean;
}

/**
 * 工作区 dockview 核心：读取持久化的 tabs/layout，渲染镜像与快照面板。
 */
export function WorkspaceDockCore({
  workspace,
  dockScope,
  className = "workspace-panel workspace-panel-dock",
  preActions,
  acceptExternalDrops = true,
  tabStyle = "topbar",
  windowControl = false,
  windowChromeVariant = "default",
  windowChromeLeftActions,
  emptyContent = <div className="dashboard dashboard-home" />,
  contentSuspended = false,
}: WorkspaceDockCoreProps) {
  const workspaceId = workspace.id;
  const { t } = useI18n();
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);
  // 按 tabId 局部 invalidate 的 key；右键「重载」时 bump 对应 tabId 触发 remount
  const [refreshKeys, setRefreshKeys] = useState<Record<string, string>>({});

  const rawTabs = useWorkspaceBottomDockStore(
    (state) => state.tabsByWorkspace[workspaceId],
  );
  const savedLayout = useWorkspaceBottomDockStore(
    (state) => state.layoutByWorkspace[workspaceId] ?? null,
  );
  const rawActiveTabId = useWorkspaceBottomDockStore(
    (state) => state.activeTabByWorkspace[workspaceId],
  );
  const ensureWorkspaceData = useWorkspaceBottomDockStore(
    (state) => state.ensureWorkspaceData,
  );
  const setLayout = useWorkspaceBottomDockStore((state) => state.setLayout);
  const setActiveTabId = useWorkspaceBottomDockStore((state) => state.setActiveTabId);
  const addMirroredTab = useWorkspaceBottomDockStore((state) => state.addMirroredTab);
  const addPayloadTab = useWorkspaceBottomDockStore((state) => state.addPayloadTab);
  const removeTab = useWorkspaceBottomDockStore((state) => state.removeTab);

  useEffect(() => {
    ensureWorkspaceData(workspaceId, workspace);
  }, [ensureWorkspaceData, workspaceId, workspace.name, workspace.description]);

  const tabs = useMemo(
    () => resolveWorkspaceTabs(workspace, rawTabs),
    [workspace, rawTabs],
  );

  const activeTabId = useMemo(
    () => resolveWorkspaceActiveTabId(workspace, tabs, rawActiveTabId),
    [workspace, tabs, rawActiveTabId],
  );

  const [visitedTabIds, setVisitedTabIds] = useState(() =>
    createInitialDockTabVisited(activeTabId),
  );

  useEffect(() => {
    if (contentSuspended) return;
    setVisitedTabIds((prev) => markDockTabVisited(prev, activeTabId));
  }, [activeTabId, contentSuspended]);

  const dockTabs = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        closable: tab.closable !== false,
        panelType: resolveWorkspaceDockPanelType(tab),
      })),
    [tabs],
  );

  const effectiveSavedLayout = tabs.length > 0 ? savedLayout : null;

  useEffect(() => {
    if (tabs.length === 0) return;
    const tabIds = tabs.map((tab) => tab.id);
    if (savedLayout && isLayoutUsable(savedLayout)) {
      const panelIds = collectPanelIds(savedLayout);
      if (tabs.every((tab) => panelIds.has(tab.id))) return;
    }
    const merged =
      mergePanelsIntoLayout(savedLayout, tabIds, activeTabId) ??
      buildDefaultWorkspaceLayout(workspace, tabs, activeTabId);
    if (merged) {
      setLayout(workspaceId, merged);
    }
  }, [activeTabId, savedLayout, setLayout, tabs, workspace, workspaceId]);

  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith(`${dockScope}:`)) return;
      if (isModuleDockScope(meta.originScope)) {
        applyModuleTransferToWorkspace(
          workspaceId,
          workspace,
          meta,
          addPayloadTab,
          addMirroredTab,
          setActiveTabId,
        );
        requestDockScopeResync(dockScope);
        return;
      }
      addMirroredTab(workspaceId, workspace, {
        id: meta.newPanelId,
        label:
          typeof meta.params?.label === "string" && meta.params.label
            ? meta.params.label
            : meta.title,
        originScope: meta.originScope,
        originPanelId: meta.originPanelId,
      });
      requestDockScopeResync(dockScope);
    });
  }, [addMirroredTab, addPayloadTab, dockScope, setActiveTabId, workspaceId, workspace]);

  const renderPanel = useCallback(
    (tabId: string) => {
      if (
        !shouldMountDockTabContent({
          active: tabId === activeTabId,
          visited: visitedTabIds.has(tabId),
          contentSuspended,
        })
      ) {
        return null;
      }
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return null;
      return <WorkspaceDockTabPanel tab={tab} isActive={tabId === activeTabId} />;
    },
    [contentSuspended, tabs, activeTabId, visitedTabIds],
  );

  const softRefreshKey = contentSuspended ? "suspended" : "live";

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (isWorkspaceBuiltinTabId(tabId)) return;
      const tab = tabs.find((item) => item.id === tabId);
      cleanupWorkspaceDockTab(tab);
      removeTab(workspaceId, workspace, tabId);
    },
    [removeTab, tabs, workspace, workspaceId],
  );

  const handlePanelTransferredOut = useCallback(
    (panelId: string, targetScope: string) => {
      const tab = tabs.find((item) => item.id === panelId);
      if (!tab) return;
      // terminal payload 拖回终端：保留 session，由终端侧 subscribeDockviewTransfer 接管，
      // 不释放资源、不进最近关闭（属于"移动"而非"关闭"）。
      const isTerminalMoveToTerminal =
        targetScope === "terminal" &&
        tab.kind === "payload" &&
        tab.payload?.module === "terminal";
      if (isTerminalMoveToTerminal) {
        removeTab(workspaceId, workspace, panelId, { skipRecentClosed: true });
        return;
      }
      cleanupWorkspaceDockTab(tab);
      removeTab(workspaceId, workspace, panelId);
    },
    [removeTab, tabs, workspace, workspaceId],
  );

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      setActiveTabId(workspaceId, tabId);
      syncWorkspaceDockActiveTabSideEffects(tabs.find((item) => item.id === tabId));
    },
    [setActiveTabId, tabs, workspaceId],
  );

  const handleTabContextMenu = useCallback(
    (event: React.MouseEvent, tabId: string, index: number) => {
      event.preventDefault();
      setCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );

  const handleRefreshTab = useCallback((tabId: string) => {
    setRefreshKeys((prev) => ({
      ...prev,
      [tabId]: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }));
    setCtxMenu(null);
  }, []);

  const handleMoveToMain = useCallback(
    async (tab: WorkspaceDockTab) => {
      await moveWorkspaceTabToMain(workspaceId, tab, tab.id);
      setCtxMenu(null);
    },
    [workspaceId],
  );

  const handleMoveToWorkspace = useCallback(
    async (targetWorkspaceId: string, tab: WorkspaceDockTab) => {
      if (!tab.payload) return;
      await deliverSnapshotToWorkspace(targetWorkspaceId, tab.payload, { activate: true });
      cleanupWorkspaceDockTab(tab);
      removeTab(workspaceId, workspace, tab.id, { skipRecentClosed: true });
      setCtxMenu(null);
    },
    [removeTab, workspace, workspaceId],
  );

  const handleCloseAction = useCallback(
    (action: "close" | "closeLeft" | "closeRight" | "closeOthers" | "closeAll") => {
      if (!ctxMenu) return;
      const tabId = ctxMenu.tabId;
      if (action === "close") {
        handleCloseTab(tabId);
      } else if (action === "closeLeft") {
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx > 0) tabs.slice(0, idx).forEach((t) => handleCloseTab(t.id));
      } else if (action === "closeRight") {
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx >= 0 && idx < tabs.length - 1) {
          tabs.slice(idx + 1).forEach((t) => handleCloseTab(t.id));
        }
      } else if (action === "closeOthers") {
        tabs.filter((t) => t.id !== tabId).forEach((t) => handleCloseTab(t.id));
      } else if (action === "closeAll") {
        tabs.forEach((t) => handleCloseTab(t.id));
      }
      setCtxMenu(null);
    },
    [ctxMenu, handleCloseTab, tabs],
  );

  return (
    <>
    <DockableWorkspace
      className={className}
      dockScope={dockScope}
      acceptExternalDrops={acceptExternalDrops}
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={handleActiveTabChange}
      onCloseTab={handleCloseTab}
      onPanelTransferredOut={handlePanelTransferredOut}
      onTabContextMenu={handleTabContextMenu}
      panelContentKeysByTab={refreshKeys}
      savedLayout={effectiveSavedLayout}
      onSavedLayoutChange={(layout) => setLayout(workspaceId, layout)}
      renderPanel={renderPanel}
      softRefreshKey={softRefreshKey}
      // sticky-visited：宿主 always，未访问 Tab render null（与 ModuleSegmentDock 对齐）
      defaultRenderer="always"
      tabStyle={tabStyle}
      preActions={preActions}
      windowControl={windowControl}
      windowChromeVariant={windowChromeVariant}
      windowChromeLeftActions={windowChromeLeftActions}
      enableTabGroups={false}
      emptyContent={emptyContent}
    />
    {ctxMenu && (() => {
      const ctxTab = tabs.find((item) => item.id === ctxMenu.tabId);
      const tabIndex = tabs.findIndex((item) => item.id === ctxMenu.tabId);
      const tabCount = tabs.length;
      const isBuiltin = ctxTab ? isWorkspaceBuiltinTabId(ctxTab.id) : false;
      const canMoveToMain = ctxTab && !isBuiltin;
      const canMoveToWorkspace = ctxTab?.kind === "payload" && ctxTab.payload;
      const canClose = ctxTab?.closable !== false && !isBuiltin;

      const items: ContextMenuItem[] = [];

      if (!isBuiltin && ctxTab) {
        items.push({
          id: "ws-tab-refresh",
          label: t("shell.topbar.refresh"),
          onClick: () => handleRefreshTab(ctxTab.id),
        });
        items.push({ id: "ws-tab-sep-1", separator: true, label: "" });
      }

      if (canMoveToMain && ctxTab) {
        items.push({
          id: "ws-tab-move-to-main",
          label: t("shell.workspace.moveToMain"),
          onClick: () => {
            void handleMoveToMain(ctxTab);
          },
        });
      }

      if (canMoveToWorkspace && ctxTab) {
        const others = workspaces.filter((ws) => ws.id !== workspaceId);
        const wsChildren: ContextMenuItem[] =
          others.length > 0
            ? others.map((ws) => ({
                id: `ws-tab-move-to-ws-${ws.id}`,
                label: ws.name || ws.id,
                onClick: () => {
                  void handleMoveToWorkspace(ws.id, ctxTab);
                },
              }))
            : [
                {
                  id: "ws-tab-move-to-ws-none",
                  label: t("shell.workspace.noOther"),
                  disabled: true,
                  onClick: () => {},
                },
              ];
        items.push({
          id: "ws-tab-move-to-other-ws",
          label: t("shell.workspace.moveToOther"),
          children: wsChildren,
        });
      }

      if (canMoveToMain || canMoveToWorkspace) {
        items.push({ id: "ws-tab-sep-2", separator: true, label: "" });
      }

      if (canClose) {
        items.push({
          id: "ws-tab-close",
          label: t("shell.topbar.closeCurrent"),
          onClick: () => handleCloseAction("close"),
        });
        items.push({
          id: "ws-tab-close-bulk",
          label: t("shell.topbar.closeTabs"),
          children: buildTabBulkCloseSubmenuItems(
            t,
            tabCount,
            tabIndex >= 0 ? tabIndex : 0,
            handleCloseAction,
          ),
        });
      }

      return (
        <ContextMenu
          items={items}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      );
    })()}
    </>
  );
}
