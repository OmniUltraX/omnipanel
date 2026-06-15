import { useCallback, useEffect, useMemo } from "react";
import { DockableWorkspace } from "../dock";
import { WorkspaceEmptyPage } from "../ui/WorkspaceEmptyPage";
import { subscribeDockviewTransfer } from "../../lib/dockviewRegistry";
import { useI18n } from "../../i18n";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import {
  resolveWorkspaceActiveTabId,
  resolveWorkspaceDockPanelType,
  resolveWorkspaceTabs,
  useWorkspaceBottomDockStore,
} from "../../stores/workspaceBottomDockStore";
import { getDbWorkspaceMirrorContext } from "../../stores/dbWorkspaceMirrorStore";
import { WorkspaceMirroredPanel } from "./WorkspaceMirroredPanel";

interface WorkspacePanelProps {
  workspace: WorkspaceInfo;
}

function workspaceDockScope(workspaceId: string): string {
  return `workspace-bottom-${workspaceId}`;
}

/**
 * 单个工程工作区的底部 dockview 面板：默认欢迎页，可接收其他模块拖入的 panel。
 */
export function WorkspacePanel({ workspace }: WorkspacePanelProps) {
  const { t } = useI18n();
  const workspaceId = workspace.id;
  const dockScope = workspaceDockScope(workspaceId);

  const rawTabs = useWorkspaceBottomDockStore(
    (state) => state.tabsByWorkspace[workspaceId],
  );
  const savedLayout = useWorkspaceBottomDockStore(
    (state) => state.layoutByWorkspace[workspaceId] ?? null,
  );
  const rawActiveTabId = useWorkspaceBottomDockStore(
    (state) => state.activeTabByWorkspace[workspaceId],
  );
  const ensureWelcomeTab = useWorkspaceBottomDockStore(
    (state) => state.ensureWelcomeTab,
  );
  const setLayout = useWorkspaceBottomDockStore((state) => state.setLayout);
  const setActiveTabId = useWorkspaceBottomDockStore((state) => state.setActiveTabId);
  const addMirroredTab = useWorkspaceBottomDockStore((state) => state.addMirroredTab);
  const removeTab = useWorkspaceBottomDockStore((state) => state.removeTab);

  useEffect(() => {
    ensureWelcomeTab(workspaceId, workspace);
  }, [ensureWelcomeTab, workspaceId, workspace.name, workspace.description]);

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

  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith(`${dockScope}:`)) return;
      addMirroredTab(workspaceId, workspace, {
        id: meta.newPanelId,
        label: meta.title,
        originScope: meta.originScope,
        originPanelId: meta.originPanelId,
      });
    });
  }, [addMirroredTab, dockScope, workspaceId, workspace.name, workspace.description]);

  const welcomePrompt =
    workspace.description.trim() || t("shell.workspacePanel.welcomePrompt");

  const renderPanel = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return null;
      if (tab.kind === "welcome") {
        return (
          <WorkspaceEmptyPage
            title={workspace.name}
            prompt={welcomePrompt}
            className="workspace-panel__welcome"
          />
        );
      }
      return <WorkspaceMirroredPanel tab={tab} isActive={tabId === activeTabId} />;
    },
    [tabs, workspace.name, welcomePrompt, activeTabId],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      removeTab(workspaceId, workspace, tabId);
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
    },
    [setActiveTabId, tabs, workspaceId],
  );

  return (
    <DockableWorkspace
      className="workspace-panel"
      dockScope={dockScope}
      acceptExternalDrops
      tabs={dockTabs}
      activeTabId={activeTabId}
      onActiveTabChange={handleActiveTabChange}
      onCloseTab={handleCloseTab}
      savedLayout={savedLayout}
      onSavedLayoutChange={(layout) => setLayout(workspaceId, layout)}
      renderPanel={renderPanel}
      emptyContent={
        <WorkspaceEmptyPage
          title={workspace.name}
          prompt={welcomePrompt}
          className="workspace-panel__welcome"
        />
      }
    />
  );
}

