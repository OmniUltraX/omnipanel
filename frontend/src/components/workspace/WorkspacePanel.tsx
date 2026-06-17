import { useCallback, useEffect, useMemo } from "react";
import { DockableWorkspace } from "../dock";
import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import { HomeBoardView } from "../../modules/workspace/HomeBoardView";
import { useI18n } from "../../i18n";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import {
  resolveWorkspaceActiveTabId,
  resolveWorkspaceDockPanelType,
  resolveWorkspaceTabs,
  buildDefaultWorkspaceLayout,
  useWorkspaceBottomDockStore,
} from "../../stores/workspaceBottomDockStore";
import { isLayoutUsable, collectPanelIds } from "../dock/dockViewLayout";
import { getDbWorkspaceMirrorContext } from "../../stores/dbWorkspaceMirrorStore";
import { WorkspaceMirroredPanel } from "./WorkspaceMirroredPanel";
import { WorkspacePayloadPanel } from "./WorkspacePayloadPanel";

interface WorkspacePanelProps {
  workspace: WorkspaceInfo;
}

function workspaceDockScope(workspaceId: string): string {
  return `workspace-bottom-${workspaceId}`;
}

/**
 * 工程工作区 dockview：顶栏集成工作区切换 + Tab + 分屏，支持镜像拖入与快照物化。
 */
export function WorkspacePanel({ workspace }: WorkspacePanelProps) {
  const { t } = useI18n();
  const workspaceId = workspace.id;
  const dockScope = workspaceDockScope(workspaceId);
  const isEngineeringFullscreen = useBottomPanelStore(
    (state) => state.isFullscreen && !state.isHomeActive,
  );
  const enterWorkspaceFullscreen = useBottomPanelStore(
    (state) => state.enterWorkspaceFullscreen,
  );

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
    [workspaceId, workspace.name, workspace.description, rawTabs],
  );

  const activeTabId = useMemo(
    () => resolveWorkspaceActiveTabId(workspace, tabs, rawActiveTabId),
    [workspaceId, workspace.name, tabs, rawActiveTabId],
  );

  const dockTabs = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        closable: tab.closable,
        panelType: resolveWorkspaceDockPanelType(tab),
      })),
    [tabs],
  );
  const effectiveSavedLayout = tabs.length > 0 ? savedLayout : null;
  const dockRemountKey = `${workspaceId}:${dockTabs.map((tab) => tab.id).join("|")}`;

  useEffect(() => {
    if (tabs.length === 0) return;
    if (savedLayout && isLayoutUsable(savedLayout)) {
      const panelIds = collectPanelIds(savedLayout);
      if (tabs.every((tab) => panelIds.has(tab.id))) return;
    }
    setLayout(workspaceId, buildDefaultWorkspaceLayout(workspace, tabs, activeTabId));
  }, [
    activeTabId,
    savedLayout,
    setLayout,
    tabs,
    workspace,
    workspaceId,
  ]);

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
  }, [addMirroredTab, dockScope, workspaceId, workspace.name, workspace.description]);

  const renderPanel = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return null;
      if (tab.kind === "payload" && tab.payload) {
        return <WorkspacePayloadPanel tab={tab} isActive={tabId === activeTabId} />;
      }
      return <WorkspaceMirroredPanel tab={tab} isActive={tabId === activeTabId} />;
    },
    [tabs, activeTabId],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      removeTab(workspaceId, workspace, tabId);
    },
    [removeTab, workspace, workspaceId],
  );

  const handlePanelTransferredOut = useCallback(
    (panelId: string) => {
      removeTab(workspaceId, workspace, panelId);
    },
    [removeTab, workspace, workspaceId],
  );

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      setActiveTabId(workspaceId, tabId);
      const tab = tabs.find((item) => item.id === tabId);
      if (
        tab?.kind === "mirrored" &&
        tab.originScope === "database" &&
        tab.originPanelId
      ) {
        getDbWorkspaceMirrorContext()?.setActiveTabId(tab.originPanelId);
      }
      if (tab?.kind === "payload" && tab.payload?.module === "database") {
        getDbWorkspaceMirrorContext()?.setActiveTabId(tab.payload.id);
      }
    },
    [setActiveTabId, tabs, workspaceId],
  );

  const enterFullscreenFromChrome = useCallback(() => {
    if (isEngineeringFullscreen) return;
    enterWorkspaceFullscreen();
  }, [enterWorkspaceFullscreen, isEngineeringFullscreen]);

  const handleTopbarDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (isEngineeringFullscreen) return;
      const target = event.target as HTMLElement;
      const inHeader = target.closest(
        ".workspace-panel-empty-topbar, .dv-tabs-and-actions-container",
      );
      if (!inHeader) return;
      if (
        target.closest(
          ".workspace-switcher, .workspace-panel-fullscreen-btn, .dv-tab, .dv-default-tab, button, [role='button'], .drag-ignore",
        )
      ) {
        return;
      }
      enterWorkspaceFullscreen();
    },
    [enterWorkspaceFullscreen, isEngineeringFullscreen],
  );

  const preActions = useMemo(
    () => <WorkspaceSwitcher placement="below" />,
    [],
  );

  const fullscreenButton = !isEngineeringFullscreen ? (
    <button
      type="button"
      className="workspace-panel-fullscreen-btn drag-ignore"
      title={t("shell.workspacePanel.fullscreen")}
      aria-label={t("shell.workspacePanel.fullscreen")}
      onClick={enterFullscreenFromChrome}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        width="14"
        height="14"
        aria-hidden
      >
        <path d="M8 3H5a2 2 0 00-2 2v3" />
        <path d="M16 3h3a2 2 0 012 2v3" />
        <path d="M8 21H5a2 2 0 01-2-2v-3" />
        <path d="M16 21h3a2 2 0 002-2v-3" />
      </svg>
    </button>
  ) : null;

  if (tabs.length === 0) {
    return (
      <div
        className="workspace-panel workspace-panel--empty"
        onDoubleClickCapture={handleTopbarDoubleClick}
      >
        <div className="workspace-panel-empty-topbar">
          <WorkspaceSwitcher placement="below" />
          <div className="workspace-panel-empty-spacer" />
          {fullscreenButton}
        </div>
        <div className="workspace-panel-empty-body">
          <HomeBoardView />
        </div>
      </div>
    );
  }

  return (
    <div
      className="workspace-panel-frame"
      onDoubleClickCapture={handleTopbarDoubleClick}
    >
      {fullscreenButton}
      <DockableWorkspace
        key={dockRemountKey}
        className="workspace-panel workspace-panel-dock"
        dockScope={dockScope}
        acceptExternalDrops
        tabs={dockTabs}
        activeTabId={activeTabId}
        onActiveTabChange={handleActiveTabChange}
        onCloseTab={handleCloseTab}
        onPanelTransferredOut={handlePanelTransferredOut}
        savedLayout={effectiveSavedLayout}
        onSavedLayoutChange={(layout) => setLayout(workspaceId, layout)}
        renderPanel={renderPanel}
        tabStyle="topbar"
        preActions={preActions}
        windowControl={isEngineeringFullscreen}
        windowChromeVariant="segment"
        enableTabGroups={false}
        emptyContent={<HomeBoardView />}
      />
    </div>
  );
}
