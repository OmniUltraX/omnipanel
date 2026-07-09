import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import {
  findWindowLabelAtScreenPoint,
  resolveTargetWorkspaceIdForTransfer,
  screenPointToClient,
} from "./crossWindowDragUtils";
import {
  applyCrossWindowWorkspaceTabToModule,
  isModuleDockScope,
} from "./moduleToWorkspaceTransfer";
import {
  useWorkspaceBottomDockStore,
  type WorkspaceDockTab,
} from "../stores/workspaceBottomDockStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useTerminalStore } from "../stores/terminalStore";
import { cleanupWorkspaceDockTab, ensureTerminalTabFromSnapshot } from "./workspaceTabActions";
import { isTauriRuntime } from "./isTauriRuntime";
import {
  findEngineeringWorkspaceDockAt,
  findModuleDockAt,
  relayoutDockviewInstances,
  getDockviewInstanceByScope,
} from "./dockviewRegistry";

export const CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT = "omnipanel:cross-window-dock-drag-active";
export const CROSS_WINDOW_DOCK_DRAG_COMPLETE_EVENT = "omnipanel:cross-window-dock-drag-complete";
export const CROSS_WINDOW_DOCK_SOURCE_CLEANUP_EVENT =
  "omnipanel:cross-window-dock-source-cleanup";
export const WORKSPACE_DOCK_TAB_GRAB_EVENT = "omnipanel:workspace-dock-tab-grab";

interface CrossWindowDockDragPayload {
  sourceWindowLabel: string;
  sourceWorkspaceId: string;
  panelId: string;
  tab: WorkspaceDockTab;
  backendSessionId?: string | null;
}

interface CrossWindowDockDragCompletePayload extends CrossWindowDockDragPayload {
  targetWindowLabel: string;
  targetWorkspaceId: string;
  dropScreenX: number;
  dropScreenY: number;
  /** module：落入模块 dock；workspace：落入工程工作区 dock */
  transferTarget?: "workspace" | "module";
  targetModuleScope?: string;
}

const WORKSPACE_DOCK_SCOPE_PREFIX = "workspace-bottom-";
const REMOTE_DRAG_TTL_MS = 30_000;
const DRAG_THRESHOLD_PX = 4;
const WORKSPACE_DOCK_SELECTOR = ".workspace-panel-dock";

interface PointerDragSeed {
  panelId: string;
  workspaceId: string;
  tab: WorkspaceDockTab;
  startScreenX: number;
  startScreenY: number;
}

let pointerSeed: PointerDragSeed | null = null;
let localDrag: CrossWindowDockDragPayload | null = null;
let remoteDrag: (CrossWindowDockDragPayload & { expiresAt: number }) | null = null;
let activeBroadcast = false;
let dragCompletionLock = false;
let dragFinishToken = 0;
const recentTransferKeys = new Set<string>();

function transferDedupeKey(
  sourceLabel: string,
  panelId: string,
  targetLabel: string,
): string {
  return `${sourceLabel}|${panelId}|${targetLabel}`;
}

function markTransferProcessed(key: string): boolean {
  if (recentTransferKeys.has(key)) return false;
  recentTransferKeys.add(key);
  window.setTimeout(() => recentTransferKeys.delete(key), 3000);
  return true;
}

function crossDockLog(message: string): void {
  if (!import.meta.env.DEV) return;
  console.info(`[crossWindowDock] ${message}`);
}

function isWorkspaceDockElement(el: Element | null | undefined): boolean {
  return Boolean(el?.closest(WORKSPACE_DOCK_SELECTOR));
}

function dragMovedEnoughAt(screenX: number, screenY: number): boolean {
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (localDrag) return true;
  if (!pointerSeed) return isWorkspaceDockDragActive();
  if (pointerSeed.startScreenX === 0 && pointerSeed.startScreenY === 0) {
    return isWorkspaceDockDragActive();
  }
  return (
    Math.hypot(screenX - pointerSeed.startScreenX, screenY - pointerSeed.startScreenY) >=
      DRAG_THRESHOLD_PX || isWorkspaceDockDragActive()
  );
}

function resolveDragSession(): CrossWindowDockDragPayload | null {
  if (localDrag) return localDrag;
  const panelId = panelIdFromActiveDrag() ?? pointerSeed?.panelId;
  if (!panelId) return null;
  return ensureLocalDrag(panelId);
}

function resetPointerSeed(): void {
  pointerSeed = null;
  activeBroadcast = false;
}

function clearRemoteDrag(): void {
  remoteDrag = null;
}

function seedPointerFromPanelId(
  panelId: string,
  screenX: number,
  screenY: number,
): boolean {
  const found = findWorkspaceTab(panelId);
  if (!found) {
    crossDockLog(`tab not in store panelId=${panelId}`);
    return false;
  }
  pointerSeed = {
    panelId,
    workspaceId: found.workspaceId,
    tab: found.tab,
    startScreenX: screenX,
    startScreenY: screenY,
  };
  activeBroadcast = false;
  crossDockLog(`seed panelId=${panelId} ws=${found.workspaceId}`);
  return true;
}

function backendSessionIdForTab(tab: WorkspaceDockTab): string | null | undefined {
  if (tab.kind !== "payload" || tab.payload?.module !== "terminal") return undefined;
  return (
    useTerminalStore.getState().tabs.find((item) => item.id === tab.payload?.id)?.backendSessionId ??
    null
  );
}

function findWorkspaceTab(panelId: string): {
  workspaceId: string;
  tab: WorkspaceDockTab;
} | null {
  const tabsByWorkspace = useWorkspaceBottomDockStore.getState().tabsByWorkspace;
  for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
    const exact = tabs.find((item) => item.id === panelId);
    if (exact) return { workspaceId, tab: exact };
  }
  const bare = panelId.includes(":")
    ? panelId.slice(panelId.lastIndexOf(":") + 1)
    : panelId;
  for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
    const tab = tabs.find(
      (item) =>
        item.id === bare ||
        item.id.endsWith(`:${bare}`) ||
        panelId.endsWith(`:${item.id}`),
    );
    if (tab) return { workspaceId, tab };
  }
  return null;
}

function isWorkspaceDockDragActive(): boolean {
  return Boolean(
    document.querySelector(
      ".workspace-panel-dock .dv-tab-dragging, .workspace-panel-dock .dv-tab--dragging, .workspace-panel-dock .dv-resize-container-dragging",
    ),
  );
}

function panelIdFromActiveDrag(): string | null {
  const dragging = document.querySelector<HTMLElement>(
    ".workspace-panel-dock .dv-tab-dragging [data-dock-tab-id], .workspace-panel-dock .dv-tab--dragging [data-dock-tab-id], .workspace-panel-dock .dv-tab-dragging[data-dock-tab-id], .workspace-panel-dock .dv-tab--dragging[data-dock-tab-id]",
  );
  if (dragging?.dataset.dockTabId) return dragging.dataset.dockTabId;
  return pointerSeed?.panelId ?? null;
}

function ensureLocalDrag(panelId: string): CrossWindowDockDragPayload | null {
  const found = findWorkspaceTab(panelId);
  if (!found) return null;
  localDrag = {
    sourceWindowLabel: getCurrentWebviewWindow().label,
    sourceWorkspaceId: found.workspaceId,
    panelId,
    tab: found.tab,
    backendSessionId: backendSessionIdForTab(found.tab),
  };
  return localDrag;
}

async function broadcastDragActive(session: CrossWindowDockDragPayload): Promise<void> {
  if (activeBroadcast) return;
  activeBroadcast = true;
  try {
    const wins = await getAllWebviewWindows();
    await Promise.all(
      wins
        .filter((w) => w.label !== session.sourceWindowLabel)
        .map((w) =>
          emitTo(w.label, CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT, session).catch(() => {}),
        ),
    );
    crossDockLog(`broadcast active from ${session.sourceWindowLabel}`);
  } catch (e) {
    console.warn("[crossWindowDock] broadcast active failed", e);
    activeBroadcast = false;
  }
}

function applyIncomingTab(
  targetWorkspaceId: string,
  tab: WorkspaceDockTab,
  backendSessionId?: string | null,
): void {
  const workspace =
    useWorkspaceStore.getState().workspaces.find((w) => w.id === targetWorkspaceId) ??
    useWorkspaceStore.getState().workspace;
  const dock = useWorkspaceBottomDockStore.getState();
  const scope = `${WORKSPACE_DOCK_SCOPE_PREFIX}${targetWorkspaceId}`;
  const bareId = tab.id.includes(":") ? tab.id.slice(tab.id.lastIndexOf(":") + 1) : tab.id;
  const newPanelId = tab.id.startsWith(`${scope}:`) ? tab.id : `${scope}:${bareId}`;

  if (tab.kind === "payload" && tab.payload) {
    if (tab.payload.module === "terminal") {
      ensureTerminalTabFromSnapshot(tab.payload);
      if (backendSessionId) {
        useTerminalStore.getState().setBackendSessionId(tab.payload.id, backendSessionId);
      }
    }
    dock.addPayloadTab(targetWorkspaceId, workspace, {
      ...tab,
      id: newPanelId,
      kind: "payload",
      payload: tab.payload,
    });
  } else {
    dock.addMirroredTab(targetWorkspaceId, workspace, {
      ...tab,
      id: newPanelId,
      originScope: tab.originScope ?? scope,
      originPanelId: tab.originPanelId ?? bareId,
    });
  }
  dock.setActiveTabId(targetWorkspaceId, newPanelId);
  requestAnimationFrame(() => {
    relayoutDockviewInstances("workspace-bottom");
  });
}

function removeOutgoingTab(
  workspaceId: string,
  panelId: string,
  tab: WorkspaceDockTab,
  targetWorkspaceId: string,
  options?: { targetModuleScope?: string },
): void {
  const workspace =
    useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId) ??
    useWorkspaceStore.getState().workspace;
  const tabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[workspaceId] ?? [];
  const resolvedId =
    tabs.find((item) => item.id === panelId || item.id === tab.id)?.id ?? panelId;
  const targetModuleScope = options?.targetModuleScope;
  const targetScope =
    targetModuleScope ?? `${WORKSPACE_DOCK_SCOPE_PREFIX}${targetWorkspaceId}`;

  const isTerminalMoveToModule =
    targetModuleScope === "terminal" &&
    tab.kind === "payload" &&
    tab.payload?.module === "terminal";

  const removeDockPanel = () => {
    const dockInstance = getDockviewInstanceByScope(
      `${WORKSPACE_DOCK_SCOPE_PREFIX}${workspaceId}`,
    );
    if (!dockInstance) return;
    const panel = dockInstance.api.getPanel(resolvedId);
    if (!panel) return;
    dockInstance.onPanelTransferredOut?.(resolvedId, targetScope);
    try {
      dockInstance.api.removePanel(panel);
    } catch {
      // dockview 拖拽周期内可能已移除
    }
  };

  if (!isTerminalMoveToModule) {
    cleanupWorkspaceDockTab(tab);
  }
  useWorkspaceBottomDockStore.getState().removeTab(workspaceId, workspace, resolvedId, {
    skipRecentClosed: true,
  });
  requestAnimationFrame(() => {
    requestAnimationFrame(removeDockPanel);
    relayoutDockviewInstances("workspace-bottom");
  });
}

async function completeCrossWindowTransfer(
  session: CrossWindowDockDragPayload,
  targetLabel: string,
  targetWorkspaceId?: string | null,
  dropScreenX = 0,
  dropScreenY = 0,
): Promise<void> {
  const resolvedWorkspaceId =
    targetWorkspaceId ??
    resolveTargetWorkspaceIdForTransfer(targetLabel, session.sourceWorkspaceId);
  if (!resolvedWorkspaceId) {
    crossDockLog(`no target workspace for label=${targetLabel}`);
    return;
  }
  if (session.sourceWindowLabel === targetLabel) {
    crossDockLog(`same window drop label=${targetLabel}`);
    return;
  }

  const payload: CrossWindowDockDragCompletePayload = {
    ...session,
    targetWindowLabel: targetLabel,
    targetWorkspaceId: resolvedWorkspaceId,
    dropScreenX,
    dropScreenY,
  };
  crossDockLog(
    `complete ${session.sourceWindowLabel} -> ${targetLabel} panel=${session.panelId}`,
  );
  const dedupeKey = transferDedupeKey(
    session.sourceWindowLabel,
    session.panelId,
    targetLabel,
  );
  if (!markTransferProcessed(dedupeKey)) {
    crossDockLog(`complete skipped duplicate ${dedupeKey}`);
    return;
  }
  await Promise.all([
    emitTo(targetLabel, CROSS_WINDOW_DOCK_DRAG_COMPLETE_EVENT, payload).catch(() => {}),
    emitTo(session.sourceWindowLabel, CROSS_WINDOW_DOCK_DRAG_COMPLETE_EVENT, payload).catch(
      () => {},
    ),
  ]);
}

/**
 * 跨窗口 dock tab 转移（主窗 ↔ 独立工作区窗）。
 */
export function initCrossWindowDockTransfer(): () => void {
  if (!isTauriRuntime()) return () => {};

  const unlisteners: UnlistenFn[] = [];
  const dockDisposables: Array<{ dispose: () => void }> = [];
  let disposed = false;

  const finishDragAtScreenPoint = async (
    screenX: number,
    screenY: number,
    clientX: number,
    clientY: number,
    currentLabel: string,
    session: CrossWindowDockDragPayload | null,
    remote: CrossWindowDockDragPayload | null,
    finishToken: number,
  ): Promise<boolean> => {
    if (dragCompletionLock) return false;
    if (finishToken !== dragFinishToken) return false;
    dragCompletionLock = true;
    try {
      const targetLabel = await findWindowLabelAtScreenPoint(screenX, screenY, crossDockLog);
      if (!targetLabel) {
        crossDockLog("drop: no window at cursor");
        return false;
      }

      const dockHit =
        targetLabel === currentLabel
          ? findEngineeringWorkspaceDockAt(clientX, clientY)
          : undefined;
      const dockWorkspaceId = dockHit?.scope.startsWith(WORKSPACE_DOCK_SCOPE_PREFIX)
        ? dockHit.scope.slice(WORKSPACE_DOCK_SCOPE_PREFIX.length)
        : null;

      if (remote && remote.sourceWindowLabel !== currentLabel && targetLabel === currentLabel) {
        await completeCrossWindowTransfer(
          remote,
          currentLabel,
          dockWorkspaceId ?? remote.sourceWorkspaceId,
          screenX,
          screenY,
        );
        clearRemoteDrag();
        return true;
      }

      if (session && session.sourceWindowLabel === currentLabel && targetLabel !== currentLabel) {
        await completeCrossWindowTransfer(
          session,
          targetLabel,
          dockWorkspaceId,
          screenX,
          screenY,
        );
        return true;
      }

      crossDockLog(
        `drop ignored current=${currentLabel} target=${targetLabel} hasSession=${Boolean(session)} hasRemote=${Boolean(remote)}`,
      );
      return false;
    } finally {
      dragCompletionLock = false;
    }
  };

  const cleanupDragState = (): void => {
    if (!remoteDrag) {
      localDrag = null;
    }
    resetPointerSeed();
    document.body.classList.remove("omnipanel-cross-window-dock-drag");
  };

  const onTabGrab = (event: Event) => {
    const detail = (event as CustomEvent<{
      panelId?: string;
      screenX?: number;
      screenY?: number;
    }>).detail;
    const panelId = detail?.panelId;
    if (!panelId) return;
    seedPointerFromPanelId(panelId, detail.screenX ?? 0, detail.screenY ?? 0);
  };

  void (async () => {
    try {
      const [{ getPanelData }, { PointerDragController }] = await Promise.all([
        import("dockview-core"),
        import("dockview-core/dist/esm/dnd/pointer/pointerDragController"),
      ]);
      if (disposed) return;
      const dragController = PointerDragController.getInstance();

      dockDisposables.push(
        dragController.onDragStart((event) => {
          const active = dragController.active;
          if (!active || !isWorkspaceDockElement(active.source)) return;
          const data = getPanelData();
          const panelId = data?.panelId;
          if (!panelId) {
            crossDockLog("dragStart: no panel data");
            return;
          }
          seedPointerFromPanelId(
            panelId,
            event.pointerEvent.screenX,
            event.pointerEvent.screenY,
          );
        }),
      );

      dockDisposables.push(
        dragController.onDragMove(() => {
          const panelId = panelIdFromActiveDrag();
          if (!panelId) return;
          const session = ensureLocalDrag(panelId);
          if (session) void broadcastDragActive(session);
        }),
      );

      dockDisposables.push(
        dragController.onDragEnd(() => {
          // 跨窗完成仅在 pointerup 处理，避免与 dockview _handleEnd 竞态导致 Invalid grid element
          if (!pointerSeed && !localDrag) {
            cleanupDragState();
          }
        }),
      );

      crossDockLog("dockview pointer bridge attached");
    } catch (e) {
      console.warn("[crossWindowDock] dockview pointer bridge unavailable", e);
    }
  })();

  const onPointerMove = (event: PointerEvent) => {
    if (!(event.buttons & 1)) return;
    if (!pointerSeed && !isWorkspaceDockDragActive()) return;

    if (pointerSeed && pointerSeed.startScreenX === 0 && pointerSeed.startScreenY === 0) {
      pointerSeed.startScreenX = event.screenX;
      pointerSeed.startScreenY = event.screenY;
    }

    const panelId = panelIdFromActiveDrag();
    if (!panelId) return;

    const movedEnough =
      !pointerSeed ||
      pointerSeed.startScreenX === 0 ||
      Math.hypot(event.screenX - pointerSeed.startScreenX, event.screenY - pointerSeed.startScreenY) >=
        DRAG_THRESHOLD_PX ||
      isWorkspaceDockDragActive();

    if (!movedEnough) return;

    const session = ensureLocalDrag(panelId);
    if (session) void broadcastDragActive(session);
  };

  const onPointerUp = (event: PointerEvent) => {
    const currentLabel = getCurrentWebviewWindow().label;
    const remote =
      remoteDrag && remoteDrag.expiresAt > Date.now() ? remoteDrag : null;

    if (!remote && !pointerSeed && !localDrag && !isWorkspaceDockDragActive()) {
      return;
    }

    if (!remote && !dragMovedEnoughAt(event.screenX, event.screenY)) {
      cleanupDragState();
      return;
    }

    void (async () => {
      if (!remote) {
        const targetLabel = await findWindowLabelAtScreenPoint(
          event.screenX,
          event.screenY,
          crossDockLog,
        );
        if (!targetLabel || targetLabel === currentLabel) {
          // 同窗：可能拖回终端/模块 dock，交给 dockview onWillDrop，不拦截 pointerup
          return;
        }
      }

      const session = resolveDragSession();
      const finishToken = ++dragFinishToken;

      event.preventDefault();
      event.stopImmediatePropagation();

      await finishDragAtScreenPoint(
        event.screenX,
        event.screenY,
        event.clientX,
        event.clientY,
        currentLabel,
        session,
        remote,
        finishToken,
      );
    })()
      .catch((e) => {
        console.warn("[crossWindowDock] pointerup failed", e);
      })
      .finally(cleanupDragState);
  };

  const observer = new MutationObserver(() => {
    if (!isWorkspaceDockDragActive()) return;
    const panelId = panelIdFromActiveDrag();
    if (!panelId) return;
    const session = ensureLocalDrag(panelId);
    if (session) void broadcastDragActive(session);
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  window.addEventListener(WORKSPACE_DOCK_TAB_GRAB_EVENT, onTabGrab);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);

  void listen<CrossWindowDockDragPayload>(
    CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      if (payload.sourceWindowLabel === getCurrentWebviewWindow().label) return;
      remoteDrag = { ...payload, expiresAt: Date.now() + REMOTE_DRAG_TTL_MS };
      document.body.classList.add("omnipanel-cross-window-dock-drag");
      crossDockLog(`remote active from ${payload.sourceWindowLabel}`);
    },
    { target: { kind: "Any" } },
  ).then((fn) => unlisteners.push(fn));

  void listen<CrossWindowDockDragCompletePayload>(
    CROSS_WINDOW_DOCK_DRAG_COMPLETE_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      const currentLabel = getCurrentWebviewWindow().label;
      crossDockLog(
        `complete event current=${currentLabel} src=${payload.sourceWindowLabel} tgt=${payload.targetWindowLabel}`,
      );

      if (payload.targetWindowLabel === currentLabel) {
        const { clientX, clientY } = screenPointToClient(
          payload.dropScreenX,
          payload.dropScreenY,
        );
        const moduleDock = findModuleDockAt(clientX, clientY);
        if (moduleDock && isModuleDockScope(moduleDock.scope)) {
          const applied = applyCrossWindowWorkspaceTabToModule(
            payload.tab,
            payload.sourceWorkspaceId,
            moduleDock.scope,
            payload.backendSessionId,
          );
          if (applied) {
            crossDockLog(`applied workspace tab to module scope=${moduleDock.scope}`);
            requestAnimationFrame(() => relayoutDockviewInstances(moduleDock.scope));
          }
          void emitTo(payload.sourceWindowLabel, CROSS_WINDOW_DOCK_SOURCE_CLEANUP_EVENT, {
            ...payload,
            transferTarget: "module" as const,
            targetModuleScope: moduleDock.scope,
          }).catch(() => {});
        } else {
          applyIncomingTab(
            payload.targetWorkspaceId,
            payload.tab,
            payload.backendSessionId,
          );
          void emitTo(payload.sourceWindowLabel, CROSS_WINDOW_DOCK_SOURCE_CLEANUP_EVENT, {
            ...payload,
            transferTarget: "workspace" as const,
          }).catch(() => {});
        }
      }

      document.body.classList.remove("omnipanel-cross-window-dock-drag");
      localDrag = null;
      resetPointerSeed();
      if (remoteDrag?.sourceWindowLabel === payload.sourceWindowLabel) {
        clearRemoteDrag();
      }
    },
    { target: { kind: "Any" } },
  ).then((fn) => unlisteners.push(fn));

  void listen<CrossWindowDockDragCompletePayload>(
    CROSS_WINDOW_DOCK_SOURCE_CLEANUP_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      const currentLabel = getCurrentWebviewWindow().label;
      if (payload.sourceWindowLabel !== currentLabel) return;
      removeOutgoingTab(
        payload.sourceWorkspaceId,
        payload.panelId,
        payload.tab,
        payload.targetWorkspaceId,
        payload.transferTarget === "module"
          ? { targetModuleScope: payload.targetModuleScope }
          : undefined,
      );
    },
    { target: { kind: "Any" } },
  ).then((fn) => unlisteners.push(fn));

  try {
    crossDockLog(`init on ${getCurrentWebviewWindow().label}`);
  } catch {
    crossDockLog("init");
  }

  return () => {
    disposed = true;
    observer.disconnect();
    for (const d of dockDisposables) d.dispose();
    window.removeEventListener(WORKSPACE_DOCK_TAB_GRAB_EVENT, onTabGrab);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    for (const fn of unlisteners) safeTauriUnlisten(fn);
    document.body.classList.remove("omnipanel-cross-window-dock-drag");
    pointerSeed = null;
    localDrag = null;
    clearRemoteDrag();
    activeBroadcast = false;
    dragCompletionLock = false;
    dragFinishToken = 0;
    recentTransferKeys.clear();
  };
}
