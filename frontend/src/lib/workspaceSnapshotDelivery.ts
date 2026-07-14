import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "./isTauriRuntime";
import { workspaceWindowLabel } from "./workspaceWindow";
import {
  addSnapshotToWorkspace,
  ensureTerminalTabFromSnapshot,
} from "./workspaceTabActions";
import { isWorkspacePoppedOut } from "../stores/workspaceWindowStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useWorkspaceBottomDockStore, type WorkspaceDockTab } from "../stores/workspaceBottomDockStore";
import type { WorkspaceTabSnapshot } from "../stores/workspaceTabStore";

export const WORKSPACE_ADD_SNAPSHOT_EVENT = "omnipanel:workspace-add-snapshot";

export interface WorkspaceAddSnapshotPayload {
  workspaceId: string;
  snapshot: WorkspaceTabSnapshot;
  activate?: boolean;
  backendSessionId?: string | null;
}

export const WORKSPACE_ADD_MIRRORED_TAB_EVENT = "omnipanel:workspace-add-mirrored-tab";

export interface WorkspaceAddMirroredTabPayload {
  workspaceId: string;
  tab: Omit<WorkspaceDockTab, "kind"> & { kind?: "mirrored" };
  activate?: boolean;
}

function applySnapshotLocally(
  workspaceId: string,
  snapshot: WorkspaceTabSnapshot,
  options?: { activate?: boolean; backendSessionId?: string | null },
): void {
  if (snapshot.module === "terminal") {
    ensureTerminalTabFromSnapshot(snapshot);
    if (options?.backendSessionId) {
      useTerminalStore.getState().setBackendSessionId(snapshot.id, options.backendSessionId);
    }
  }
  addSnapshotToWorkspace(workspaceId, snapshot, { activate: options?.activate });
}

async function focusWorkspaceWindow(workspaceId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = await WebviewWindow.getByLabel(workspaceWindowLabel(workspaceId));
    await win?.setFocus();
  } catch {
    /* ignore */
  }
}

/**
 * 将 Tab 快照投递到目标工作区：嵌入主窗时本地写入；已弹出独立 OS 窗时通过 Tauri 事件投递。
 */
export async function deliverSnapshotToWorkspace(
  workspaceId: string,
  snapshot: WorkspaceTabSnapshot,
  options?: { activate?: boolean; backendSessionId?: string | null },
): Promise<void> {
  const targetLabel = workspaceWindowLabel(workspaceId);
  const currentLabel = isTauriRuntime() ? getCurrentWebviewWindow().label : "main";
  const remoteTarget =
    isTauriRuntime() && isWorkspacePoppedOut(workspaceId) && currentLabel !== targetLabel;

  if (remoteTarget) {
    await emitTo(targetLabel, WORKSPACE_ADD_SNAPSHOT_EVENT, {
      workspaceId,
      snapshot,
      activate: options?.activate ?? true,
      backendSessionId: options?.backendSessionId ?? null,
    } satisfies WorkspaceAddSnapshotPayload);
    void focusWorkspaceWindow(workspaceId);
    return;
  }

  applySnapshotLocally(workspaceId, snapshot, options);
  if (currentLabel === "main" && !isWorkspacePoppedOut(workspaceId)) {
    useBottomPanelStore.getState().requestExpand();
  }
}

/** 主窗与子工作区窗均需注册，以接收跨窗「添加 Tab」事件。 */
export function initWorkspaceAddSnapshotListener(): () => void {
  if (!isTauriRuntime()) return () => {};

  const unlisteners: UnlistenFn[] = [];

  void listen<WorkspaceAddSnapshotPayload>(
    WORKSPACE_ADD_SNAPSHOT_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload?.workspaceId || !payload.snapshot) return;
      applySnapshotLocally(payload.workspaceId, payload.snapshot, {
        activate: payload.activate,
        backendSessionId: payload.backendSessionId,
      });
    },
    { target: { kind: "Any" } },
  ).then((fn) => {
    if (fn) unlisteners.push(fn);
  });

  void listen<WorkspaceAddMirroredTabPayload>(
    WORKSPACE_ADD_MIRRORED_TAB_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload?.workspaceId || !payload.tab) return;
      const workspace = useWorkspaceStore
        .getState()
        .workspaces.find((ws) => ws.id === payload.workspaceId);
      if (!workspace) return;
      useWorkspaceBottomDockStore
        .getState()
        .addMirroredTab(payload.workspaceId, workspace, payload.tab);
    },
    { target: { kind: "Any" } },
  ).then((fn) => {
    if (fn) unlisteners.push(fn);
  });

  return () => {
    for (const fn of unlisteners) fn();
  };
}

/**
 * 将镜像 Tab 投递到目标工作区：嵌入主窗时本地写入；已弹出独立 OS 窗时通过 Tauri 事件投递。
 */
export async function deliverMirroredTabToWorkspace(
  workspaceId: string,
  tab: Omit<WorkspaceDockTab, "kind"> & { kind?: "mirrored" },
): Promise<void> {
  const targetLabel = workspaceWindowLabel(workspaceId);
  const currentLabel = isTauriRuntime() ? getCurrentWebviewWindow().label : "main";
  const remoteTarget =
    isTauriRuntime() && isWorkspacePoppedOut(workspaceId) && currentLabel !== targetLabel;

  if (remoteTarget) {
    await emitTo(targetLabel, WORKSPACE_ADD_MIRRORED_TAB_EVENT, {
      workspaceId,
      tab,
      activate: true,
    } satisfies WorkspaceAddMirroredTabPayload);
    void focusWorkspaceWindow(workspaceId);
    return;
  }

  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((ws) => ws.id === workspaceId);
  if (!workspace) return;
  useWorkspaceBottomDockStore.getState().addMirroredTab(workspaceId, workspace, tab);
  if (currentLabel === "main" && !isWorkspacePoppedOut(workspaceId)) {
    useBottomPanelStore.getState().requestExpand();
  }
}
