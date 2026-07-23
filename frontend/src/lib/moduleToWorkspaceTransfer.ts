import type { TransferredPanelMeta } from "./dockviewRegistry";
import {
  findEngineeringWorkspaceDockAt,
  getDockviewInstanceByScope,
  relayoutDockviewInstances,
} from "./dockviewRegistry";
import type { WorkspaceInfo } from "../stores/workspaceStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import type { WorkspaceDockTab } from "../stores/workspaceBottomDockStore";
import { useWorkspaceBottomDockStore } from "../stores/workspaceBottomDockStore";
import type { WorkspaceTabSnapshot } from "../stores/workspaceTabStore";
import { useTerminalStore } from "../stores/terminalStore";
import { formatTerminalTabLabel } from "../modules/terminal/terminalSessionDisplay";
import { getMirroredDbTabSnapshot } from "../stores/dbWorkspaceMirrorStore";
import { useDbWorkspaceTabStore } from "../stores/dbWorkspaceTabStore";
import {
  addSnapshotToWorkspace,
  dbTabToSnapshot,
  ensureTerminalTabFromSnapshot,
  moveTerminalTabToWorkspaceSnapshot,
} from "./workspaceTabActions";
import { parseFileConnPanelId } from "../modules/files/filesWorkspacePanels";

export function isEngineeringWorkspaceScope(scope: string | undefined): boolean {
  return Boolean(scope?.startsWith("workspace-bottom-"));
}

export function isModuleDockScope(scope: string | undefined): boolean {
  if (!scope) return false;
  return !isEngineeringWorkspaceScope(scope);
}

export function shouldTransferModuleToWorkspace(
  targetScope: string | undefined,
  sourceScope: string | undefined,
): boolean {
  return isEngineeringWorkspaceScope(targetScope) && isModuleDockScope(sourceScope);
}

/** 工程工作区 payload/镜像 Tab 拖回终端、数据库等模块 dock。 */
export function shouldTransferWorkspaceToModule(
  targetScope: string | undefined,
  sourceScope: string | undefined,
): boolean {
  return isModuleDockScope(targetScope) && isEngineeringWorkspaceScope(sourceScope);
}

const WORKSPACE_BOTTOM_PREFIX = "workspace-bottom-";
const TERMINAL_PAYLOAD_PREFIX = "ws-payload:terminal:";

/** 从工作区 panel / transfer 元数据解析对应终端 tab id。 */
export function resolveTerminalIdFromWorkspacePanel(
  workspacePanelId: string,
  originScope?: string,
): string | null {
  if (workspacePanelId.startsWith(TERMINAL_PAYLOAD_PREFIX)) {
    return workspacePanelId.slice(TERMINAL_PAYLOAD_PREFIX.length);
  }
  if (workspacePanelId.startsWith(WORKSPACE_BOTTOM_PREFIX)) {
    const colonIdx = workspacePanelId.indexOf(":", WORKSPACE_BOTTOM_PREFIX.length);
    if (colonIdx > WORKSPACE_BOTTOM_PREFIX.length) {
      const bareId = workspacePanelId.slice(colonIdx + 1);
      if (bareId) return bareId;
    }
  }
  if (originScope?.startsWith(WORKSPACE_BOTTOM_PREFIX)) {
    const scopePrefix = `${originScope}:`;
    if (workspacePanelId.startsWith(scopePrefix)) {
      const bareId = workspacePanelId.slice(scopePrefix.length);
      if (bareId) return bareId;
    }
    const workspaceId = originScope.slice(WORKSPACE_BOTTOM_PREFIX.length);
    const wsTab = useWorkspaceBottomDockStore
      .getState()
      .tabsByWorkspace[workspaceId]?.find((item) => item.id === workspacePanelId);
    if (wsTab?.payload?.module === "terminal") {
      return wsTab.payload.id;
    }
    if (wsTab?.originPanelId) {
      return wsTab.originPanelId;
    }
  }
  return null;
}

/** 工作区 payload 终端 Tab 拖回终端模块 dock（恢复 workspaceOnly + 激活）。 */
export function restoreTerminalTabFromWorkspaceTransfer(
  meta: TransferredPanelMeta,
): boolean {
  const terminalId = resolveTerminalIdFromWorkspacePanel(meta.originPanelId, meta.originScope);
  if (!terminalId) return false;
  const store = useTerminalStore.getState();
  const existing = store.tabs.find((tab) => tab.id === terminalId);
  if (!existing) return false;
  if (existing.workspaceOnly) {
    store.setTabWorkspaceOnly(terminalId, false);
  }
  store.setActiveTab(terminalId);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId: terminalId } }),
  );
  requestAnimationFrame(() => relayoutDockviewInstances("terminal"));
  return true;
}

function resolveWorkspaceInfo(workspaceId: string): WorkspaceInfo | null {
  return (
    useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId) ??
    (useWorkspaceStore.getState().workspace.id === workspaceId
      ? useWorkspaceStore.getState().workspace
      : null)
  );
}

function scheduleDeferredRemoveModulePanel(
  originScope: string,
  originPanelId: string,
): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const source = getDockviewInstanceByScope(originScope);
      if (!source) return;
      try {
        const panel = source.api.getPanel(originPanelId);
        if (panel) source.api.removePanel(panel);
      } catch {
        // dockview 拖拽收尾期间可能已移除
      }
      relayoutDockviewInstances(originScope);
    });
  });
}

/** 指针落点对应的工程工作区（含空半屏占位区域）。 */
export function findModuleDropTargetWorkspace(
  clientX: number,
  clientY: number,
): { workspaceId: string } | null {
  const dock = findEngineeringWorkspaceDockAt(clientX, clientY);
  if (dock?.scope.startsWith(WORKSPACE_BOTTOM_PREFIX)) {
    return { workspaceId: dock.scope.slice(WORKSPACE_BOTTOM_PREFIX.length) };
  }

  for (const host of document.querySelectorAll<HTMLElement>(".workspace-bottom-host")) {
    const hostRect = host.getBoundingClientRect();
    if (
      clientX < hostRect.left ||
      clientX >= hostRect.right ||
      clientY < hostRect.top ||
      clientY >= hostRect.bottom
    ) {
      continue;
    }
    // 一次 querySelectorAll + 一次测量遍历：命中即返回；
    // 否则记录第一个可见面板作为 host 命中兜底，
    // 避免重复 querySelectorAll 与 getBoundingClientRect（拖拽 pointermove 高频触发）。
    const panels = host.querySelectorAll<HTMLElement>("[data-workspace-id]");
    let firstVisibleId: string | null = null;
    for (const panel of panels) {
      const workspaceId = panel.dataset.workspaceId;
      if (!workspaceId) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (
        clientX >= rect.left &&
        clientX < rect.right &&
        clientY >= rect.top &&
        clientY < rect.bottom
      ) {
        return { workspaceId };
      }
      if (firstVisibleId === null) {
        firstVisibleId = workspaceId;
      }
    }
    // 命中 host 区域但未命中子节点时，取当前可见工作区面板
    if (firstVisibleId) {
      return { workspaceId: firstVisibleId };
    }
  }

  for (const frame of document.querySelectorAll<HTMLElement>(
    ".workspace-panel-frame[data-workspace-id]",
  )) {
    const workspaceId = frame.dataset.workspaceId;
    if (!workspaceId) continue;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return { workspaceId };
    }
  }

  return null;
}

/**
 * 模块 Tab 拖入工程工作区（store 路径，与右键「移到工作区」一致，不经过 dockview 跨实例拖放）。
 */
export function commitModuleDragToWorkspace(
  targetWorkspaceId: string,
  originScope: string,
  originPanelId: string,
  title = originPanelId,
  params: Record<string, unknown> = {},
): boolean {
  const source = getDockviewInstanceByScope(originScope);
  if (!source?.api.getPanel(originPanelId)) return false;

  const targetScope = `${WORKSPACE_BOTTOM_PREFIX}${targetWorkspaceId}`;
  source.onPanelTransferredOut?.(originPanelId, targetScope);

  if (originScope === "terminal") {
    const tab = useTerminalStore.getState().tabs.find((item) => item.id === originPanelId);
    if (!tab) return false;
    addSnapshotToWorkspace(
      targetWorkspaceId,
      moveTerminalTabToWorkspaceSnapshot(tab),
      { activate: true },
    );
    scheduleDeferredRemoveModulePanel(originScope, originPanelId);
    requestAnimationFrame(() => relayoutDockviewInstances("workspace-bottom"));
    return true;
  }

  const workspace = resolveWorkspaceInfo(targetWorkspaceId);
  if (!workspace) return false;

  const wsTab = buildModuleTransferTabForWorkspace(
    targetWorkspaceId,
    originScope,
    originPanelId,
    title,
    params,
  );
  if (!wsTab) return false;

  const dock = useWorkspaceBottomDockStore.getState();
  dock.ensureWorkspaceData(targetWorkspaceId, workspace);
  const added =
    wsTab.kind === "payload" && wsTab.payload
      ? (() => {
          const { kind: _kind, ...payloadTab } = wsTab;
          return dock.addPayloadTab(targetWorkspaceId, workspace, {
            ...payloadTab,
            payload: wsTab.payload,
          });
        })()
      : (() => {
          const { kind: _kind, payload: _payload, ...mirroredTab } = wsTab;
          return dock.addMirroredTab(targetWorkspaceId, workspace, mirroredTab);
        })();
  dock.setActiveTabId(targetWorkspaceId, added.id);

  scheduleDeferredRemoveModulePanel(originScope, originPanelId);
  requestAnimationFrame(() => relayoutDockviewInstances("workspace-bottom"));
  return true;
}

function resolveTransferLabel(meta: TransferredPanelMeta): string {
  if (typeof meta.params?.label === "string" && meta.params.label.trim()) {
    return meta.params.label;
  }
  return meta.title;
}

/** 将模块 dock 拖入工程工作区时的 tab 元数据（payload 或镜像）。 */
export function buildWorkspaceTabFromModuleTransfer(
  meta: TransferredPanelMeta,
): WorkspaceDockTab | null {
  const label = resolveTransferLabel(meta);
  const { originScope, originPanelId, newPanelId } = meta;

  if (originScope === "terminal") {
    const tab = useTerminalStore.getState().tabs.find((item) => item.id === originPanelId);
    if (!tab) return null;
    const snapshot = moveTerminalTabToWorkspaceSnapshot(tab);
    return {
      id: newPanelId,
      label: formatTerminalTabLabel(
        tab.session.resourceId,
        tab.title,
        undefined,
        tab.session.shellLabel,
      ),
      kind: "payload",
      payload: snapshot,
      originScope: "terminal",
      originPanelId,
      panelType: "terminal",
    };
  }

  if (originScope === "database") {
    const mirrored = getMirroredDbTabSnapshot(originPanelId);
    const dbTab = mirrored?.tab;
    if (dbTab) {
      const tabMode = useDbWorkspaceTabStore.getState().tabModes[originPanelId];
      return {
        id: newPanelId,
        label: dbTab.label,
        kind: "payload",
        payload: dbTabToSnapshot(dbTab, tabMode),
        originScope: "database",
        originPanelId,
        panelType: "database",
      };
    }
  }

  return {
    id: newPanelId,
    label,
    kind: "mirrored",
    originScope,
    originPanelId,
    panelType:
      originScope === "files-browser"
        ? "file-connection"
        : originScope === "database"
          ? "database"
          : originScope,
  };
}

export function buildModuleTransferTabForWorkspace(
  targetWorkspaceId: string,
  originScope: string,
  originPanelId: string,
  title: string,
  params: Record<string, unknown> = {},
): WorkspaceDockTab | null {
  const dockScope = `workspace-bottom-${targetWorkspaceId}`;
  return buildWorkspaceTabFromModuleTransfer({
    newPanelId: `${dockScope}:${originPanelId}`,
    title,
    originScope,
    originPanelId,
    params,
  });
}

/** 跨 OS 窗口拖拽：在源窗序列化模块 Tab 快照（不依赖目标窗 store）。 */
export function buildModuleTabSnapshotForCrossWindowDrag(
  originScope: string,
  originPanelId: string,
  title: string,
  params: Record<string, unknown> = {},
): WorkspaceDockTab | null {
  if (originScope === "terminal") {
    const tab = useTerminalStore.getState().tabs.find((item) => item.id === originPanelId);
    if (!tab) return null;
    const snapshot = moveTerminalTabToWorkspaceSnapshot(tab);
    return {
      id: `xwin-pending:${originPanelId}`,
      label: formatTerminalTabLabel(
        tab.session.resourceId,
        tab.title,
        undefined,
        tab.session.shellLabel,
      ),
      kind: "payload",
      payload: snapshot,
      originScope: "terminal",
      originPanelId,
      panelType: "terminal",
    };
  }

  if (originScope === "database") {
    const mirrored = getMirroredDbTabSnapshot(originPanelId);
    const dbTab = mirrored?.tab;
    if (dbTab) {
      const tabMode = useDbWorkspaceTabStore.getState().tabModes[originPanelId];
      return {
        id: `xwin-pending:${originPanelId}`,
        label: dbTab.label,
        kind: "payload",
        payload: dbTabToSnapshot(dbTab, tabMode),
        originScope: "database",
        originPanelId,
        panelType: "database",
      };
    }
  }

  const label =
    typeof params.label === "string" && params.label.trim() ? params.label : title;
  return {
    id: `xwin-pending:${originPanelId}`,
    label,
    kind: "mirrored",
    originScope,
    originPanelId,
    panelType:
      originScope === "files-browser"
        ? "file-connection"
        : originScope === "database"
          ? "database"
          : originScope,
  };
}

export function remapWorkspaceTabForTarget(
  tab: WorkspaceDockTab,
  targetWorkspaceId: string,
  originPanelId: string,
): WorkspaceDockTab {
  const dockScope = `${WORKSPACE_BOTTOM_PREFIX}${targetWorkspaceId}`;
  const bareId = originPanelId.includes(":")
    ? originPanelId.slice(originPanelId.lastIndexOf(":") + 1)
    : originPanelId;
  const newId = `${dockScope}:${bareId}`;
  if (tab.kind === "payload") {
    return { ...tab, id: newId };
  }
  return {
    ...tab,
    id: newId,
    originPanelId: bareId,
    originScope: tab.originScope ?? dockScope,
  };
}

/**
 * 跨窗：工程工作区 Tab 落入模块 dock（终端 / 数据库 / 文件等）。
 */
export function applyCrossWindowWorkspaceTabToModule(
  tab: WorkspaceDockTab,
  sourceWorkspaceId: string,
  targetModuleScope: string,
  backendSessionId?: string | null,
): boolean {
  const sourceScope = `${WORKSPACE_BOTTOM_PREFIX}${sourceWorkspaceId}`;

  if (tab.kind === "payload" && tab.payload?.module === "terminal") {
    ensureTerminalTabFromSnapshot(tab.payload);
    if (backendSessionId) {
      useTerminalStore.getState().setBackendSessionId(tab.payload.id, backendSessionId);
    }
    const meta: TransferredPanelMeta = {
      newPanelId: `${targetModuleScope}:${tab.payload.id}`,
      title: tab.label,
      originScope: sourceScope,
      originPanelId: tab.id,
      params: {},
    };
    if (restoreTerminalTabFromWorkspaceTransfer(meta)) {
      return true;
    }
    const terminalId = tab.payload.id;
    const store = useTerminalStore.getState();
    if (!store.tabs.some((item) => item.id === terminalId)) return false;
    store.setTabWorkspaceOnly(terminalId, false);
    store.setActiveTab(terminalId);
    window.dispatchEvent(
      new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId: terminalId } }),
    );
    requestAnimationFrame(() => relayoutDockviewInstances(targetModuleScope));
    return true;
  }

  if (
    tab.kind === "mirrored" &&
    (tab.originScope === "terminal" || tab.panelType === "terminal")
  ) {
    const sourceScope = `${WORKSPACE_BOTTOM_PREFIX}${sourceWorkspaceId}`;
    const terminalId = resolveTerminalIdFromWorkspacePanel(
      tab.originPanelId ?? tab.id,
      tab.originScope ?? sourceScope,
    );
    if (!terminalId) return false;
    const meta: TransferredPanelMeta = {
      newPanelId: `${targetModuleScope}:${terminalId}`,
      title: tab.label,
      originScope: tab.originScope ?? sourceScope,
      originPanelId: tab.originPanelId ?? tab.id,
      params: {},
    };
    if (restoreTerminalTabFromWorkspaceTransfer(meta)) {
      return true;
    }
    const store = useTerminalStore.getState();
    if (!store.tabs.some((item) => item.id === terminalId)) return false;
    store.setTabWorkspaceOnly(terminalId, false);
    store.setActiveTab(terminalId);
    window.dispatchEvent(
      new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId: terminalId } }),
    );
    requestAnimationFrame(() => relayoutDockviewInstances(targetModuleScope));
    return true;
  }

  if (tab.kind === "payload" && tab.payload?.module === "database") {
    window.dispatchEvent(
      new CustomEvent("omnipanel:restore-db-workspace-tab", {
        detail: { snapshot: tab.payload },
      }),
    );
    return true;
  }

  if (
    tab.kind === "mirrored" &&
    (tab.originScope === "database" || tab.panelType === "database")
  ) {
    window.dispatchEvent(
      new CustomEvent("omnipanel:restore-db-workspace-tab", {
        detail: {
          snapshot: {
            module: "database",
            id: tab.originPanelId ?? tab.id,
            label: tab.label,
          },
        },
      }),
    );
    return true;
  }

  if (
    tab.kind === "mirrored" &&
    (tab.originScope === "files-browser" || tab.panelType === "file-connection")
  ) {
    const originPanelId = tab.originPanelId ?? tab.id;
    const connId = parseFileConnPanelId(originPanelId);
    if (!connId) return false;
    window.dispatchEvent(
      new CustomEvent("omnipanel:restore-files-workspace-tab", {
        detail: { connId },
      }),
    );
    return true;
  }

  return false;
}

export function applyModuleTransferToWorkspace(
  workspaceId: string,
  workspace: WorkspaceInfo,
  meta: TransferredPanelMeta,
  addPayloadTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: Omit<WorkspaceDockTab, "kind"> & { payload: WorkspaceTabSnapshot },
  ) => WorkspaceDockTab,
  addMirroredTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: Omit<WorkspaceDockTab, "kind"> & { kind?: "mirrored" },
  ) => WorkspaceDockTab,
  setActiveTabId: (workspaceId: string, tabId: string) => void,
): void {
  const tab = buildWorkspaceTabFromModuleTransfer(meta);
  if (!tab) return;
  const added =
    tab.kind === "payload" && tab.payload
      ? (() => {
          const { kind: _kind, ...payloadTab } = tab;
          return addPayloadTab(workspaceId, workspace, {
            ...payloadTab,
            payload: tab.payload,
          });
        })()
      : (() => {
          const { kind: _kind, payload: _payload, ...mirroredTab } = tab;
          return addMirroredTab(workspaceId, workspace, mirroredTab);
        })();
  setActiveTabId(workspaceId, added.id);
  useBottomPanelStore.getState().requestExpand();
}
