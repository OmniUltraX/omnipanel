import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { DockableWorkspace } from "../dock";
import { relayoutDockviewInstances, subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import {
  resolveWorkspaceActiveTabId,
  resolveWorkspaceDockPanelType,
  resolveWorkspaceTabs,
  buildDefaultWorkspaceLayout,
  useWorkspaceBottomDockStore,
} from "../../stores/workspaceBottomDockStore";
import { isWorkspaceBuiltinTabId } from "../../lib/workspaceBuiltinPanels";
import { isLayoutUsable, collectPanelIds, mergePanelsIntoLayout } from "../dock/dockViewLayout";
import { syncWorkspaceDockActiveTabSideEffects } from "../../lib/syncWorkspaceDockActiveTab";
import { cleanupWorkspaceDockTab } from "../../lib/workspaceTabActions";
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
}: WorkspaceDockCoreProps) {
  const workspaceId = workspace.id;

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
      addMirroredTab(workspaceId, workspace, {
        id: meta.newPanelId,
        label:
          typeof meta.params?.label === "string" && meta.params.label
            ? meta.params.label
            : meta.title,
        originScope: meta.originScope,
        originPanelId: meta.originPanelId,
      });
    });
  }, [addMirroredTab, dockScope, workspaceId, workspace]);

  const renderPanel = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return null;
      return <WorkspaceDockTabPanel tab={tab} isActive={tabId === activeTabId} />;
    },
    [tabs, activeTabId],
  );

  // 仅随激活 Tab 触发 softRefresh，更新 isActive 状态，避免 remount 导致状态丢失
  const softRefreshKey = activeTabId;

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

  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);

  // task-bar 首次最大化时 dock 才挂载，注册后补一次全屏 relayout
  useEffect(() => {
    if (!isFullscreen) return;
    const sidebarW = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"),
    ) || 56;
    const run = () => {
      relayoutDockviewInstances("workspace-bottom", {
        width: Math.max(0, window.innerWidth - sidebarW),
        height: Math.max(0, window.innerHeight - 26),
      });
    };
    run();
    const raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen, dockScope]);

  return (
    <DockableWorkspace
      className={className}
      dockScope={dockScope}
      acceptExternalDrops={acceptExternalDrops}
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={handleActiveTabChange}
      onCloseTab={handleCloseTab}
      onPanelTransferredOut={handlePanelTransferredOut}
      savedLayout={effectiveSavedLayout}
      onSavedLayoutChange={(layout) => setLayout(workspaceId, layout)}
      renderPanel={renderPanel}
      softRefreshKey={softRefreshKey}
      tabStyle={tabStyle}
      preActions={preActions}
      windowControl={windowControl}
      windowChromeVariant={windowChromeVariant}
      windowChromeLeftActions={windowChromeLeftActions}
      enableTabGroups={false}
      emptyContent={emptyContent}
    />
  );
}
