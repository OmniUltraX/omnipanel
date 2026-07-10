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
import type { WorkspaceTabSnapshot } from "../stores/workspaceTabStore";

export const WORKSPACE_ADD_SNAPSHOT_EVENT = "omnipanel:workspace-add-snapshot";

export interface WorkspaceAddSnapshotPayload {
  workspaceId: string;
  snapshot: WorkspaceTabSnapshot;
  activate?: boolean;
  backendSessionId?: string | null;
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

  let unlisten: UnlistenFn | null = null;
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
    unlisten = fn;
  });

  return () => {
    unlisten?.();
    unlisten = null;
  };
}
