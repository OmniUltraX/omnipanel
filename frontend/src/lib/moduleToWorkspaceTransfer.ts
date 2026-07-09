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
import { useTerminalStore } from "../stores/terminalStore";
import { formatTerminalTabLabel } from "../modules/terminal/terminalSessionDisplay";
import { getMirroredDbTabSnapshot } from "../stores/dbWorkspaceMirrorStore";
import { useDbWorkspaceTabStore } from "../stores/dbWorkspaceTabStore";
import {
  addSnapshotToWorkspace,
  dbTabToSnapshot,
  moveTerminalTabToWorkspaceSnapshot,
} from "./workspaceTabActions";
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
  if (originScope?.startsWith(WORKSPACE_BOTTOM_PREFIX)) {
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
    for (const panel of host.querySelectorAll<HTMLElement>("[data-workspace-id]")) {
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
    }
    // 命中 host 区域但未命中子节点时，取当前可见工作区面板
    for (const panel of host.querySelectorAll<HTMLElement>("[data-workspace-id]")) {
      const workspaceId = panel.dataset.workspaceId;
      if (!workspaceId) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { workspaceId };
      }
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
    wsTab.kind === "payload"
      ? dock.addPayloadTab(targetWorkspaceId, workspace, wsTab)
      : dock.addMirroredTab(targetWorkspaceId, workspace, wsTab);
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

export function applyModuleTransferToWorkspace(
  workspaceId: string,
  workspace: WorkspaceInfo,
  meta: TransferredPanelMeta,
  addPayloadTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: WorkspaceDockTab,
  ) => WorkspaceDockTab,
  addMirroredTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: WorkspaceDockTab,
  ) => WorkspaceDockTab,
  setActiveTabId: (workspaceId: string, tabId: string) => void,
): void {
  const tab = buildWorkspaceTabFromModuleTransfer(meta);
  if (!tab) return;
  const added =
    tab.kind === "payload"
      ? addPayloadTab(workspaceId, workspace, tab)
      : addMirroredTab(workspaceId, workspace, tab);
  setActiveTabId(workspaceId, added.id);
  useBottomPanelStore.getState().requestExpand();
}
