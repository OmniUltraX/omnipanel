import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./isTauriRuntime";
import { useWorkspaceWindowStore } from "../stores/workspaceWindowStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { syncEmbeddedWorkspacePanelVisibility, hideMainWindowWorkspaceEmbedding } from "./workspaceTabActions";
import {
  buildWorkspaceWindowHandoffJson,
  prepareWorkspaceWindowHandoff,
  writeWorkspaceWindowCloseHandoff,
} from "./workspaceWindowHandoff";
import { showToast } from "../stores/toastStore";
import { WORKSPACE_PATHS } from "./paths";

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
  await prepareWorkspaceWindowHandoff(workspaceId);
  const handoffJson = await buildWorkspaceWindowHandoffJson(workspaceId);

  // 乐观更新：invoke 完成前先收起主窗底栏，避免弹出过程闪一下 taskbar
  useWorkspaceWindowStore.getState().markPoppedOut(workspaceId);
  useWorkspaceStore.getState().setWorkspaceWindowForm(workspaceId, "windowed");
  hideMainWindowWorkspaceEmbedding(workspaceId);

  try {
    // 从 workspaceStore 读取上次窗口位置和大小，缺失时由后端使用默认值居中
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
    const bounds = ws?.windowBounds ?? null;

    const label = await invoke<string>("open_workspace_window", {
      workspaceId,
      title,
      handoffJson,
      bounds,
    });

    syncEmbeddedWorkspacePanelVisibility(workspaceId);
    await workspaceWindowDebugLog(`open ok label=${label}`);

    // 主窗当前停留在该工作区的 /workspace/:id 全屏路由时，工作区已被弹出，
    // UserWorkspace 组件 return null，WorkspaceBottomHost 也会过滤掉它，
    // 主窗右侧会变成空白。此时需导航回首页看板。
    if (window.location.pathname === WORKSPACE_PATHS.detail(workspaceId)) {
      const { goWorkspaceHome } = await import("./workspaceNavigation");
      goWorkspaceHome();
    }

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

  // 启动时清理过期的 handoff 文件（TTL 5 分钟，防止崩溃后残留文件导致恢复不一致）
  try {
    await invoke("cleanup_expired_handoffs");
  } catch {
    /* ignore */
  }

  useWorkspaceWindowStore.getState().setPoppedOut([]);
  const ids = await listOpenWorkspaceWindowIds();
  useWorkspaceWindowStore.getState().setPoppedOut(ids);
  for (const id of ids) {
    syncEmbeddedWorkspacePanelVisibility(id);
  }

  // 启动恢复：检查哪些工作区上次以独立窗口形式存在，自动弹出
  const workspaces = useWorkspaceStore.getState().workspaces;
  const windowedWorkspaces = workspaces.filter((w) => w.windowForm === "windowed");
  for (const ws of windowedWorkspaces) {
    // 已经活着的窗口不重复打开
    if (ids.includes(ws.id)) continue;
    // 异步弹出，不阻塞主窗启动
    void openWorkspaceWindow(ws.id, ws.name).catch(() => {
      // 弹出失败时回退为 embedded
      useWorkspaceStore.getState().setWorkspaceWindowForm(ws.id, "embedded");
    });
  }

  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen<WorkspaceWindowEventPayload>(WORKSPACE_WINDOW_OPENED_EVENT, (event) => {
      const id = event.payload?.workspaceId;
      if (!id) return;
      useWorkspaceWindowStore.getState().markPoppedOut(id);
      syncEmbeddedWorkspacePanelVisibility(id);
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
        useWorkspaceStore.getState().setWorkspaceWindowForm(id, "embedded");
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
        useWorkspaceStore.getState().setWorkspaceWindowForm(id, "embedded");
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
      for (const id of liveIds) {
        syncEmbeddedWorkspacePanelVisibility(id);
      }
    });
  }, 30000);

  return () => {
    window.clearInterval(timer);
    for (const un of unlisteners) un();
  };
}

/**
 * 检查工作区是否有未保存数据（SQL 脏行 / 活跃终端会话）。
 * 任一条件命中即返回 true；检查过程中出错按 false 处理，避免阻塞关闭。
 */
async function checkUnsavedData(workspaceId: string): Promise<boolean> {
  try {
    // 检查数据库脏行
    const { useDbWorkspaceTabStore } = await import("../stores/dbWorkspaceTabStore");
    const dbState = useDbWorkspaceTabStore.getState();
    const dockTabs =
      (await import("../stores/workspaceBottomDockStore")).useWorkspaceBottomDockStore.getState()
        .tabsByWorkspace[workspaceId] ?? [];

    for (const tab of dockTabs) {
      // 提取 tabId（可能带前缀，如 ws-payload:db:xxx）
      let tabId = tab.id;
      const lastColon = tabId.lastIndexOf(":");
      if (lastColon >= 0) tabId = tabId.slice(lastColon + 1);

      const dirtyRows = dbState.tabDirtyRows[tabId];
      if (dirtyRows && Object.keys(dirtyRows).length > 0) return true;
    }

    // 检查终端活跃会话
    const { useTerminalStore } = await import("../stores/terminalStore");
    const terminalTabs = useTerminalStore.getState().tabs;
    for (const tab of terminalTabs) {
      if (tab.workspaceId === workspaceId && tab.status === "connected") {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * 弹出 Tauri 原生确认对话框，询问用户是否确认关闭。
 * dialog 不可用时默认返回 true（允许关闭），避免阻塞正常流程。
 */
async function confirmClose(_workspaceId: string): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(
      "该工作区有未保存的数据（SQL 脏行或活跃终端会话），确定要关闭吗？",
      { title: "关闭确认", kind: "warning" },
    );
  } catch {
    return true;
  }
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
    unlistenClose = await getCurrentWindow().onCloseRequested(
      async (event: CloseRequestedEvent) => {
        // 检查是否有未保存数据
        const hasUnsavedData = await checkUnsavedData(workspaceId);
        if (hasUnsavedData) {
          const confirmed = await confirmClose(workspaceId);
          if (!confirmed) {
            event.preventDefault();
            return;
          }
        }
        // 采集窗口几何信息（物理像素），便于下次恢复位置和大小
        try {
          const win = getCurrentWindow();
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          useWorkspaceStore.getState().setWorkspaceBounds(workspaceId, {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
          });
        } catch {
          /* ignore */
        }
        await writeWorkspaceWindowCloseHandoff(workspaceId);
        await emit(WORKSPACE_WINDOW_CLOSED_EVENT, payload).catch(() => {});
      },
    );
  } catch {
    /* ignore */
  }

  return () => {
    unlistenClose?.();
  };
}
