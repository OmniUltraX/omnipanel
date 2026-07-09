import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./isTauriRuntime";
import { useWorkspaceWindowStore } from "../stores/workspaceWindowStore";
import {
  buildWorkspaceWindowHandoffJson,
  prepareWorkspaceWindowHandoff,
  writeWorkspaceWindowCloseHandoff,
} from "./workspaceWindowHandoff";
import { showToast } from "../stores/toastStore";

const WORKSPACE_WINDOW_FLAG = "workspace";
const WORKSPACE_WINDOW_LABEL_PREFIX = "workspace-";

export const WORKSPACE_WINDOW_OPENED_EVENT = "omnipanel:workspace-window-opened";
export const WORKSPACE_WINDOW_CLOSED_EVENT = "omnipanel:workspace-window-closed";
export const WORKSPACE_WINDOW_DESTROYED_EVENT = "omnipanel:workspace-window-destroyed";

interface WorkspaceWindowEventPayload {
  workspaceId: string;
  label?: string;
}

export interface WorkspaceWindowParams {
  workspaceId: string;
}

export async function workspaceWindowDebugLog(message: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    console.log(`[workspaceWindow] ${message}`);
    return null;
  }
  try {
    const path = await invoke<string>("workspace_window_debug_log", { message });
    console.log(`[workspaceWindow] ${message} | log=${path}`);
    return path;
  } catch (e) {
    console.log(`[workspaceWindow] ${message} (log failed: ${e})`);
    return null;
  }
}

export function workspaceWindowLabel(workspaceId: string): string {
  const safe = encodeURIComponent(workspaceId).replace(/%/g, "_");
  return `${WORKSPACE_WINDOW_LABEL_PREFIX}${safe}`;
}

export function workspaceIdFromLabel(label: string): string | null {
  if (!label.startsWith(WORKSPACE_WINDOW_LABEL_PREFIX)) return null;
  const encoded = label.slice(WORKSPACE_WINDOW_LABEL_PREFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded.replace(/_/g, "%"));
  } catch {
    return encoded;
  }
}

export function parseWorkspaceWindowParams(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): WorkspaceWindowParams | null {
  if (typeof window !== "undefined") {
    const injected = (window as Window & { __OMNIPANEL_WORKSPACE_WINDOW__?: unknown })
      .__OMNIPANEL_WORKSPACE_WINDOW__;
    if (typeof injected === "string" && injected.trim()) {
      return { workspaceId: injected };
    }
  }

  if (isTauriRuntime()) {
    try {
      const id = workspaceIdFromLabel(getCurrentWindow().label);
      if (id) return { workspaceId: id };
    } catch {
      /* ignore */
    }
  }

  const params = new URLSearchParams(search);
  if (params.get("win") !== WORKSPACE_WINDOW_FLAG) return null;
  const workspaceId = params.get("ws");
  if (!workspaceId) return null;
  return { workspaceId };
}

export async function listOpenWorkspaceWindowIds(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  try {
    const all = await getAllWebviewWindows();
    return all
      .map((w) => workspaceIdFromLabel(w.label))
      .filter((id): id is string => Boolean(id));
  } catch (e) {
    console.error("[workspaceWindow] 列举独立窗口失败", e);
    return [];
  }
}

export async function dockWorkspaceWindowToMain(workspaceId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await writeWorkspaceWindowCloseHandoff(workspaceId);
    await emit(WORKSPACE_WINDOW_CLOSED_EVENT, {
      workspaceId,
    } satisfies WorkspaceWindowEventPayload);
    await getCurrentWindow().close();
  } catch (e) {
    console.error("[workspaceWindow] 收回主窗口失败", e);
    showToast(e instanceof Error ? e.message : String(e));
  }
}

export async function openWorkspaceWindow(
  workspaceId: string,
  title: string,
): Promise<void> {
  if (!isTauriRuntime()) {
    showToast("非 Tauri 运行时，无法创建独立窗口");
    return;
  }

  await workspaceWindowDebugLog(`open begin id=${workspaceId}`);
  prepareWorkspaceWindowHandoff(workspaceId);
  const handoffJson = buildWorkspaceWindowHandoffJson(workspaceId);

  try {
    const label = await invoke<string>("open_workspace_window", {
      workspaceId,
      title,
      handoffJson,
    });

    useWorkspaceWindowStore.getState().markPoppedOut(workspaceId);
    await workspaceWindowDebugLog(`open ok label=${label}`);

    const win = await WebviewWindow.getByLabel(label);
    if (win) {
      void win.once("tauri://destroyed", () => {
        // CLOSED 事件已处理 handoff；此处仅兜底清标记
        useWorkspaceWindowStore.getState().clearPoppedOut(workspaceId);
      });
    }
  } catch (e) {
    useWorkspaceWindowStore.getState().clearPoppedOut(workspaceId);
    const message = e instanceof Error ? e.message : String(e);
    await workspaceWindowDebugLog(`open FAILED: ${message}`);
    showToast(`打开独立窗口失败: ${message}`);
    throw e;
  }
}

export async function initMainWindowWorkspaceSync(): Promise<() => void> {
  if (!isTauriRuntime()) {
    useWorkspaceWindowStore.getState().setPoppedOut([]);
    return () => {};
  }

  useWorkspaceWindowStore.getState().setPoppedOut([]);
  const ids = await listOpenWorkspaceWindowIds();
  useWorkspaceWindowStore.getState().setPoppedOut(ids);

  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen<WorkspaceWindowEventPayload>(WORKSPACE_WINDOW_OPENED_EVENT, (event) => {
      const id = event.payload?.workspaceId;
      if (id) useWorkspaceWindowStore.getState().markPoppedOut(id);
    }),
  );
  unlisteners.push(
    await listen<WorkspaceWindowEventPayload>(WORKSPACE_WINDOW_CLOSED_EVENT, (event) => {
      const id = event.payload?.workspaceId;
      if (!id) return;
      void (async () => {
        const { applyWorkspaceWindowReturnHandoff } = await import(
          "./workspaceWindowHandoff"
        );
        await applyWorkspaceWindowReturnHandoff(id);
        useWorkspaceWindowStore.getState().clearPoppedOut(id);
        const { useWorkspaceStore } = await import("../stores/workspaceStore");
        const { useBottomPanelStore } = await import("../stores/bottomPanelStore");
        const { WORKSPACE_PATHS } = await import("./paths");
        useWorkspaceStore.getState().switchWorkspace(id);
        useBottomPanelStore.getState().enterWorkspaceFullscreen();
        window.dispatchEvent(
          new CustomEvent("omnipanel-navigate", {
            detail: { path: WORKSPACE_PATHS.detail(id) },
          }),
        );
      })();
    }),
  );
  unlisteners.push(
    await listen<WorkspaceWindowEventPayload>(WORKSPACE_WINDOW_DESTROYED_EVENT, (event) => {
      const id = event.payload?.workspaceId;
      if (!id) return;
      void (async () => {
        if (!useWorkspaceWindowStore.getState().isPoppedOut(id)) return;
        const { applyWorkspaceWindowReturnHandoff } = await import(
          "./workspaceWindowHandoff"
        );
        await applyWorkspaceWindowReturnHandoff(id);
        useWorkspaceWindowStore.getState().clearPoppedOut(id);
      })();
    }),
  );

  const timer = window.setInterval(() => {
    void listOpenWorkspaceWindowIds().then((liveIds) => {
      const current = useWorkspaceWindowStore.getState().poppedOutIds;
      if (
        liveIds.length === current.length &&
        liveIds.every((id) => current.includes(id))
      ) {
        return;
      }
      useWorkspaceWindowStore.getState().setPoppedOut(liveIds);
    });
  }, 3000);

  return () => {
    window.clearInterval(timer);
    for (const un of unlisteners) un();
  };
}

export async function initWorkspaceWindowLifecycle(
  workspaceId: string,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const payload: WorkspaceWindowEventPayload = { workspaceId };

  await workspaceWindowDebugLog(
    `child lifecycle id=${workspaceId} label=${getCurrentWindow().label}`,
  );
  void emit(WORKSPACE_WINDOW_OPENED_EVENT, payload).catch(() => {});

  let unlistenClose: UnlistenFn | null = null;
  try {
    unlistenClose = await getCurrentWindow().onCloseRequested(async () => {
      await writeWorkspaceWindowCloseHandoff(workspaceId);
      await emit(WORKSPACE_WINDOW_CLOSED_EVENT, payload).catch(() => {});
    });
  } catch {
    /* ignore */
  }

  return () => {
    unlistenClose?.();
  };
}
