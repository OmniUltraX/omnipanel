import { useCallback, useEffect, useMemo } from "react";
import { DockableWorkspace } from "../dock";
import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import { HomeBoardView } from "../../modules/workspace/HomeBoardView";
import { useI18n } from "../../i18n";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore, useEmbeddedWorkspaceMode } from "../../stores/bottomPanelStore";
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
import { WorkspaceThumbnailStrip } from "./WorkspaceThumbnailStrip";
import { WorkspaceTaskbarStrip } from "./WorkspaceTaskbarStrip";
import { WorkspaceFullscreenDragHandle } from "./WorkspaceFullscreenDragHandle";

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
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const isEngineeringFullscreen = workspaceMode === "fullscreen";
  const embeddedMode = useEmbeddedWorkspaceMode();
  const handleWorkspaceChromeIcon = useBottomPanelStore(
    (state) => state.handleWorkspaceChromeIcon,
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

  const panelContentKey = useMemo(
    () => `${activeTabId}|${tabs.map((tab) => tab.id).join(",")}`,
    [activeTabId, tabs],
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
    handleWorkspaceChromeIcon();
  }, [handleWorkspaceChromeIcon]);

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

  const showHomeInSwitcher = embeddedMode === "half";

  const preActions = useMemo(
    () => <WorkspaceSwitcher placement="below" showHome={showHomeInSwitcher} />,
    [showHomeInSwitcher],
  );

  const fullscreenButton = (
    <button
      type="button"
      className="workspace-panel-fullscreen-btn drag-ignore"
      title={
        isEngineeringFullscreen
          ? t("shell.workspace.home")
          : t("shell.workspacePanel.fullscreen")
      }
      aria-label={
        isEngineeringFullscreen
          ? t("shell.workspace.home")
          : t("shell.workspacePanel.fullscreen")
      }
      onClick={enterFullscreenFromChrome}
    >
      {isEngineeringFullscreen ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.5z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
          <path d="M8 3H5a2 2 0 00-2 2v3" />
          <path d="M16 3h3a2 2 0 012 2v3" />
          <path d="M8 21H5a2 2 0 01-2-2v-3" />
          <path d="M16 21h3a2 2 0 002-2v-3" />
        </svg>
      )}
    </button>
  );

  if (embeddedMode === "thumbnail") {
    return (
      <div className="workspace-panel-frame workspace-panel--thumbnail">
        <WorkspaceThumbnailStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleActiveTabChange}
        />
      </div>
    );
  }

  if (embeddedMode === "taskbar") {
    return (
      <div className="workspace-panel-frame workspace-panel--taskbar">
        <div className="workspace-taskbar-bar">
          <WorkspaceTaskbarStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={handleActiveTabChange}
          />
          {fullscreenButton}
        </div>
      </div>
    );
  }

  const frameClassName = [
    "workspace-panel-frame",
    isEngineeringFullscreen ? "workspace-panel-frame--engineering-full" : "",
    tabs.length === 0 ? "workspace-panel--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const dockClassName = "workspace-panel workspace-panel-dock";

  if (tabs.length === 0) {
    return (
      <div
        className={frameClassName}
        onDoubleClickCapture={handleTopbarDoubleClick}
      >
        {isEngineeringFullscreen ? <WorkspaceFullscreenDragHandle /> : null}
        {fullscreenButton}
        <DockableWorkspace
          key={`${workspaceId}:empty`}
          className={dockClassName}
          dockScope={dockScope}
          acceptExternalDrops
          tabs={[]}
          activeTabId=""
          onActiveTabChange={handleActiveTabChange}
          onCloseTab={handleCloseTab}
          onPanelTransferredOut={handlePanelTransferredOut}
          savedLayout={null}
          onSavedLayoutChange={(layout) => setLayout(workspaceId, layout)}
          renderPanel={renderPanel}
          panelContentKey={panelContentKey}
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

  return (
    <div
      className={frameClassName}
      onDoubleClickCapture={handleTopbarDoubleClick}
    >
      {isEngineeringFullscreen ? <WorkspaceFullscreenDragHandle /> : null}
      {fullscreenButton}
      <DockableWorkspace
        key={dockRemountKey}
        className={dockClassName}
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
        panelContentKey={panelContentKey}
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
