import type { ModuleKey } from "./paths";
import { buildModuleRouteSnapshot } from "./workspaceModuleRoutes";
import type { WorkspaceInfo } from "../stores/workspaceStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type {
  WorkspaceTabSnapshot,
  TerminalTabSnapshot,
  DbTabSnapshot,
  DockerTabSnapshot,
} from "../stores/workspaceTabStore";
import {
  resolveWorkspaceTabs,
  useWorkspaceBottomDockStore,
  type WorkspaceDockClosedEntry,
  type WorkspaceDockTab,
} from "../stores/workspaceBottomDockStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { isWorkspacePoppedOut } from "../stores/workspaceWindowStore";
import { formatTerminalTabLabel } from "../modules/terminal/terminalSessionDisplay";
import {
  useTerminalStore,
  createTerminalSessionId,
  type TerminalTab,
} from "../stores/terminalStore";
import { disposeTabBackendSessions } from "../hooks/useTerminal";
import { clearPaneBackendPending } from "../hooks/useTerminal";
import { clearTerminalPaneSender } from "../modules/terminal/terminalPaneSenders";
import type { DbWorkspaceTab } from "../modules/database/workspace/workspaceTabs";
import {
  buildComponentSnapshot,
  type ComponentSnapshot,
} from "./workspaceComponentTypes";
import { getWorkspaceComponentDefinition } from "./workspaceComponentTypes";
import { workspaceComponentRegistry } from "./workspaceComponentRegistry";
import { syncWorkspaceDockActiveTabSideEffects } from "./syncWorkspaceDockActiveTab";

/** 当前工程工作区底部 dock 中的用户面板数（不含旧版内置 Tab）。 */
export function currentWorkspaceDockTabCount(workspaceId?: string): number {
  const id = workspaceId ?? useWorkspaceStore.getState().workspace.id;
  const workspace =
    useWorkspaceStore.getState().workspaces.find((item) => item.id === id) ??
    useWorkspaceStore.getState().workspace;
  const rawTabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[id];
  return resolveWorkspaceTabs(workspace, rawTabs).length;
}

/** 已弹出独立 OS 窗的工作区不在主窗底栏展示；仅收起嵌入态，不因空 Tab 自动隐藏。 */
export function syncEmbeddedWorkspacePanelVisibility(workspaceId?: string): void {
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen || bottom.workspaceMode === "fullscreen") return;
  const id = workspaceId ?? useWorkspaceStore.getState().workspace.id;
  if (!isWorkspacePoppedOut(id)) return;
  if (bottom.workspaceMode !== "hidden") {
    bottom.requestCollapse();
  }
}

// --- Snapshot factories ---

export function terminalTabToSnapshot(tab: TerminalTab): TerminalTabSnapshot {
  return {
    module: "terminal",
    id: tab.id,
    label: formatTerminalTabLabel(
      tab.session.resourceId,
      tab.title,
      undefined,
      tab.session.shellLabel,
    ),
    sessionType: tab.session.type,
    resourceId: tab.session.resourceId,
    shellLabel: tab.session.shellLabel,
    cwd: tab.session.cwd,
    purpose: tab.session.purpose,
  };
}

/** Copy terminal session into workspace as a new tab (new id and backend session). */
export function copyTerminalTabToWorkspaceSnapshot(
  source: TerminalTab,
): TerminalTabSnapshot {
  return {
    module: "terminal",
    id: createTerminalSessionId(),
    label: formatTerminalTabLabel(
      source.session.resourceId,
      source.title,
      undefined,
      source.session.shellLabel,
    ),
    sessionType: source.session.type,
    resourceId: source.session.resourceId,
    shellLabel: source.session.shellLabel,
    cwd: source.session.cwd,
    purpose: source.session.purpose,
  };
}

/** Move terminal session into workspace (keeps id/connection; hidden from source panel). */
export function moveTerminalTabToWorkspaceSnapshot(
  source: TerminalTab,
): TerminalTabSnapshot {
  return {
    module: "terminal",
    id: source.id,
    label: formatTerminalTabLabel(
      source.session.resourceId,
      source.title,
      undefined,
      source.session.shellLabel,
    ),
    sessionType: source.session.type,
    resourceId: source.session.resourceId,
    shellLabel: source.session.shellLabel,
    cwd: source.session.cwd,
    purpose: source.session.purpose,
  };
}

export function dbTabToSnapshot(
  tab: DbWorkspaceTab,
  tabMode?: "data" | "sql",
): DbTabSnapshot {
  return {
    module: "database",
    id: tab.id,
    label: tab.label,
    tab,
    tabMode,
  };
}

export function dockerTabToSnapshot(
  subTab: "logs" | "terminal",
  connectionId: string,
  containerId: string,
  containerName: string,
): DockerTabSnapshot {
  return {
    module: "docker",
    id: `docker:${subTab}:${containerId}:${Date.now()}`,
    label: `${containerName} \u00B7 ${subTab === "logs" ? "\u65E5\u5FD7" : "\u7EC8\u7AEF"}`,
    subTab,
    connectionId,
    containerId,
    containerName,
  };
}

/** Stable id for workspace Dock payload panels. */
export function payloadDockTabId(snapshot: WorkspaceTabSnapshot): string {
  if (snapshot.module === "route") {
    return `ws-payload:${snapshot.id}`;
  }
  if (snapshot.module === "component") {
    return `ws-payload:component:${snapshot.id}`;
  }
  return `ws-payload:${snapshot.module}:${snapshot.id}`;
}

/** Expand bottom workspace and activate a Dock tab without route navigation. */
function activateWorkspaceDockTab(workspaceId: string, tab: WorkspaceDockTab): void {
  const bottom = useBottomPanelStore.getState();
  if (!bottom.isFullscreen && bottom.workspaceMode === "hidden") {
    bottom.requestExpand();
  }

  const applyActivation = () => {
    const dockStore = useWorkspaceBottomDockStore.getState();
    dockStore.setActiveTabId(workspaceId, tab.id);
    syncWorkspaceDockActiveTabSideEffects(tab);
    window.dispatchEvent(
      new CustomEvent("omnipanel-workspace-dock-activate", {
        detail: { workspaceId, tabId: tab.id },
      }),
    );
  };

  const needsExpand = !bottom.isFullscreen && bottom.workspaceMode === "hidden";
  if (needsExpand) {
    requestAnimationFrame(() => requestAnimationFrame(applyActivation));
  } else {
    queueMicrotask(applyActivation);
  }
}

function resolveActiveTerminalTab(): TerminalTab | undefined {
  const store = useTerminalStore.getState();
  const moduleTabs = store.tabs.filter((tab) => !tab.workspaceOnly);
  if (store.activeTabId) {
    const active = moduleTabs.find((tab) => tab.id === store.activeTabId);
    if (active) return active;
  }
  return moduleTabs[0];
}

/** Ensure terminal store has a tab for the snapshot (workspace payload rendering). */
export function ensureTerminalTabFromSnapshot(snapshot: TerminalTabSnapshot): string {
  const store = useTerminalStore.getState();
  const existing = store.tabs.find((tab) => tab.id === snapshot.id);
  if (existing) return existing.id;
  store.addTab({
    id: snapshot.id,
    title: snapshot.label,
    workspaceOnly: true,
    session: {
      type: snapshot.sessionType,
      resourceId: snapshot.resourceId,
      shellLabel: snapshot.shellLabel,
      cwd: snapshot.cwd,
      purpose: snapshot.purpose,
      commandPack: [],
    },
  });
  return snapshot.id;
}

/** Release resources when closing a workspace Dock payload tab. */
export function cleanupWorkspaceDockTab(tab: WorkspaceDockTab | undefined): void {
  if (!tab || tab.kind !== "payload" || !tab.payload) return;
  if (tab.payload.module === "database") {
    const dbTabId = tab.payload.id;
    window.dispatchEvent(new CustomEvent("omnipanel:close-db-workspace-tab", { detail: dbTabId }));
    return;
  }

  if (tab.payload.module !== "terminal") return;
  const terminalId = tab.payload.id;
  const terminalTab = useTerminalStore.getState().tabs.find((item) => item.id === terminalId);
  if (!terminalTab?.workspaceOnly) return;
  clearTerminalPaneSender(terminalId);
  clearPaneBackendPending(terminalId);
  disposeTabBackendSessions(terminalId);
  useTerminalStore.getState().removeTab(terminalId);
}

function resolveWorkspaceInfo(workspaceId: string): WorkspaceInfo | null {
  return (
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId) ?? null
  );
}

/**
 * Materialize a source snapshot as an engineering-workspace Dock tab.
 * Does not write workspaceTabStore (module tabs restore separately on workspace switch).
 */
export function addSnapshotToWorkspace(
  workspaceId: string,
  snapshot: WorkspaceTabSnapshot,
  options?: { activate?: boolean },
): void {
  const workspace = resolveWorkspaceInfo(workspaceId);
  if (!workspace) {
    return;
  }

  const dockStore = useWorkspaceBottomDockStore.getState();
  dockStore.ensureWorkspaceData(workspaceId, workspace);

  const payloadId = payloadDockTabId(snapshot);
  const addedTab = dockStore.addPayloadTab(workspaceId, workspace, {
    id: payloadId,
    label: snapshot.label,
    payload: snapshot,
    originScope:
      snapshot.module === "database" || snapshot.module === "terminal" || snapshot.module === "docker"
        ? snapshot.module
        : undefined,
    originPanelId:
      snapshot.module === "database" || snapshot.module === "terminal" || snapshot.module === "docker"
        ? snapshot.id
        : undefined,
    panelType:
      snapshot.module === "route"
        ? snapshot.moduleKey
        : snapshot.module === "component"
          ? snapshot.componentType
          : snapshot.module,
  });

  if (options?.activate === false) {
    return;
  }

  activateWorkspaceDockTab(workspaceId, addedTab);
}

/** Sidebar add-to-workspace: prefer module context (e.g. terminal session), else module route panel. */
export function addModulePanelToWorkspace(
  workspaceId: string,
  moduleKey: ModuleKey,
  label: string,
  options?: { segmentTabId?: string; activate?: boolean },
): void {
  if (moduleKey === "terminal") {
    const activeTab = resolveActiveTerminalTab();
    if (activeTab) {
      addSnapshotToWorkspace(
        workspaceId,
        copyTerminalTabToWorkspaceSnapshot(activeTab),
        options,
      );
      return;
    }
  }

  addModuleRouteToWorkspace(workspaceId, moduleKey, label, options);
}

/** Add a module route panel to workspace (top-level route panel). */
export function addModuleRouteToWorkspace(
  workspaceId: string,
  moduleKey: ModuleKey,
  label: string,
  options?: { segmentTabId?: string; activate?: boolean },
): void {
  addSnapshotToWorkspace(
    workspaceId,
    buildModuleRouteSnapshot(moduleKey, label, {
      segmentTabId: options?.segmentTabId,
    }),
    { activate: options?.activate },
  );
}

/** Add a serializable component/sub-panel to workspace. */
export function addComponentToWorkspace(
  workspaceId: string,
  input: {
    componentType: string;
    label: string;
    props?: Record<string, unknown>;
    snapshotId?: string;
  },
  options?: { activate?: boolean },
): void {
  const def = getWorkspaceComponentDefinition(workspaceComponentRegistry, input.componentType);
  if (!def) {
    return;
  }
  const snapshot: ComponentSnapshot = buildComponentSnapshot({
    componentType: input.componentType,
    label: input.label || def.defaultLabel || input.componentType,
    props: input.props,
    snapshotId: input.snapshotId,
  });
  addSnapshotToWorkspace(workspaceId, snapshot, options);
}

/** Sync table data tab to bottom Dock when a database workspace panel already exists. */
export function syncDatabaseTableTabToWorkspace(
  tab: DbWorkspaceTab,
  tabMode: "data" | "sql" = "data",
): void {
  const workspaceId = useWorkspaceStore.getState().workspace.id;
  const dockTabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];
  const hasDatabaseDockPanel = dockTabs.some(
    (item) =>
      (item.kind === "payload" && item.payload?.module === "database") ||
      (item.kind === "mirrored" && item.originScope === "database"),
  );
  if (!hasDatabaseDockPanel) {
    return;
  }
  addSnapshotToWorkspace(workspaceId, dbTabToSnapshot(tab, tabMode), { activate: true });
}

/** Reopen a tab from the recent-closed list. */
export function reopenWorkspaceDockTab(
  workspaceId: string,
  workspace: WorkspaceInfo,
  entry: WorkspaceDockClosedEntry,
): void {
  const dockStore = useWorkspaceBottomDockStore.getState();
  const currentTabs = dockStore.tabsByWorkspace[workspaceId] ?? [];
  const existing = currentTabs.find((item) => item.id === entry.tab.id);
  if (existing) {
    activateWorkspaceDockTab(workspaceId, existing);
    dockStore.removeRecentClosedTab(workspaceId, entry.closedAt);
    return;
  }

  dockStore.ensureWorkspaceData(workspaceId, workspace);
  const { tab } = entry;

  if (tab.kind === "payload" && tab.payload) {
    if (tab.payload.module === "database") {
      window.dispatchEvent(
        new CustomEvent("omnipanel:restore-db-workspace-tab", {
          detail: { snapshot: tab.payload },
        }),
      );
    } else if (tab.payload.module === "terminal") {
      ensureTerminalTabFromSnapshot(tab.payload);
    }
    addSnapshotToWorkspace(workspaceId, tab.payload);
  } else if (tab.kind === "mirrored") {
    const addedTab = dockStore.addMirroredTab(workspaceId, workspace, {
      id: tab.id,
      label: tab.label,
      originScope: tab.originScope,
      originPanelId: tab.originPanelId,
      panelType: tab.panelType,
      payload: tab.payload,
      closable: tab.closable,
    });
    activateWorkspaceDockTab(workspaceId, addedTab);
  }

  dockStore.removeRecentClosedTab(workspaceId, entry.closedAt);
}
