import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  findEngineeringWorkspaceDockAt,
  findModuleDockPanelById,
  getDockviewInstance,
  getDockviewInstanceByScope,
  relayoutDockviewInstances,
} from "./dockviewRegistry";
import {
  buildModuleTabSnapshotForCrossWindowDrag,
  buildModuleTransferTabForWorkspace,
  findModuleDropTargetWorkspace,
  isModuleDockScope,
  remapWorkspaceTabForTarget,
} from "./moduleToWorkspaceTransfer";
import { findWindowLabelAtScreenPoint, resolveTargetWorkspaceIdForTransfer } from "./crossWindowDragUtils";
import { isTauriRuntime } from "./isTauriRuntime";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useWorkspaceBottomDockStore, type WorkspaceDockTab } from "../stores/workspaceBottomDockStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { ensureTerminalTabFromSnapshot } from "./workspaceTabActions";
import {
  broadcastCrossWindowDragEnd,
  broadcastCrossWindowDragMove,
} from "./crossWindowDragVisual";

export const CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT =
  "omnipanel:cross-window-module-drag-active";
export const CROSS_WINDOW_MODULE_DRAG_COMPLETE_EVENT =
  "omnipanel:cross-window-module-drag-complete";
export const MODULE_DOCK_TAB_GRAB_EVENT = "omnipanel:module-dock-tab-grab";

interface CrossWindowModuleDragPayload {
  sourceWindowLabel: string;
  originScope: string;
  panelId: string;
  title: string;
  params: Record<string, unknown>;
  backendSessionId?: string | null;
  /** 源窗序列化的工作区 Tab 快照，跨窗时目标窗不依赖本地模块 store */
  serializedTab?: WorkspaceDockTab | null;
}

interface CrossWindowModuleDragCompletePayload extends CrossWindowModuleDragPayload {
  targetWindowLabel: string;
  targetWorkspaceId: string;
}

const REMOTE_DRAG_TTL_MS = 30_000;
const DRAG_THRESHOLD_PX = 4;
const MODULE_DRAG_BODY_CLASS = "omnipanel-cross-window-module-drag";

interface ModulePointerSeed {
  panelId: string;
  sourceViewId: string;
  originScope: string;
  startScreenX: number;
  startScreenY: number;
}

let pointerSeed: ModulePointerSeed | null = null;
let localDrag: CrossWindowModuleDragPayload | null = null;
let remoteDrag: (CrossWindowModuleDragPayload & { expiresAt: number }) | null = null;
let activeBroadcast = false;
let dragCompletionLock = false;
let dragFinishToken = 0;
const recentTransferKeys = new Set<string>();

function bridgeLog(message: string): void {
  if (!import.meta.env.DEV) return;
  console.info(`[moduleToWorkspaceDrag] ${message}`);
}

function isModuleDockDragActive(): boolean {
  return Boolean(
    document.querySelector(
      ".dockable-workspace:not(.workspace-panel-dock) .dv-tab-dragging, .dockable-workspace:not(.workspace-panel-dock) .dv-tab--dragging",
    ),
  );
}

function panelIdFromActiveModuleDrag(): string | null {
  const dragging = document.querySelector<HTMLElement>(
    ".dockable-workspace:not(.workspace-panel-dock) .dv-tab-dragging [data-dock-tab-id], .dockable-workspace:not(.workspace-panel-dock) .dv-tab--dragging [data-dock-tab-id], .dockable-workspace:not(.workspace-panel-dock) .dv-tab-dragging[data-dock-tab-id], .dockable-workspace:not(.workspace-panel-dock) .dv-tab--dragging[data-dock-tab-id]",
  );
  if (dragging?.dataset.dockTabId) return dragging.dataset.dockTabId;
  return pointerSeed?.panelId ?? null;
}

function seedPointerFromModulePanelId(
  panelId: string,
  dockScope: string | undefined,
  screenX: number,
  screenY: number,
): boolean {
  const found =
    (dockScope ? getDockviewInstanceByScope(dockScope) : undefined) ??
    findModuleDockPanelById(panelId);
  if (!found || !isModuleDockScope(found.scope)) {
    bridgeLog(`module tab not in dock panelId=${panelId}`);
    return false;
  }
  if (!found.api.getPanel(panelId)) return false;
  pointerSeed = {
    panelId,
    sourceViewId: found.viewId,
    originScope: found.scope,
    startScreenX: screenX,
    startScreenY: screenY,
  };
  activeBroadcast = false;
  document.body.classList.add(MODULE_DRAG_BODY_CLASS);
  bridgeLog(`grab ${found.scope}:${panelId}`);
  return true;
}

function dragMovedEnoughAt(screenX: number, screenY: number): boolean {
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (localDrag) return true;
  if (!pointerSeed) return isModuleDockDragActive();
  if (pointerSeed.startScreenX === 0 && pointerSeed.startScreenY === 0) {
    return isModuleDockDragActive();
  }
  return (
    Math.hypot(screenX - pointerSeed.startScreenX, screenY - pointerSeed.startScreenY) >=
      DRAG_THRESHOLD_PX || isModuleDockDragActive()
  );
}

function resetPointerSeed(): void {
  pointerSeed = null;
  activeBroadcast = false;
}

function clearRemoteDrag(): void {
  remoteDrag = null;
}

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

function backendSessionIdForModule(originScope: string, panelId: string): string | null | undefined {
  if (originScope !== "terminal") return undefined;
  return useTerminalStore.getState().tabs.find((item) => item.id === panelId)?.backendSessionId ?? null;
}

function buildLocalDragSession(
  panelId: string,
  sourceViewId: string,
): CrossWindowModuleDragPayload | null {
  const source = getDockviewInstance(sourceViewId);
  if (!source || !isModuleDockScope(source.scope)) return null;
  const panel = source.api.getPanel(panelId);
  if (!panel) return null;

  const serialized = source.api.toJSON();
  const panelDef = serialized.panels?.[panelId];
  const title = panel.api.title || panelId;
  const params = (panelDef?.params ?? {}) as Record<string, unknown>;

  return {
    sourceWindowLabel: getCurrentWebviewWindow().label,
    originScope: source.scope,
    panelId,
    title,
    params,
    backendSessionId: backendSessionIdForModule(source.scope, panelId),
    serializedTab: buildModuleTabSnapshotForCrossWindowDrag(
      source.scope,
      panelId,
      title,
      params,
    ),
  };
}

function ensureLocalDrag(panelId: string, sourceViewId: string): CrossWindowModuleDragPayload | null {
  const session = buildLocalDragSession(panelId, sourceViewId);
  if (!session) return null;
  localDrag = session;
  return session;
}

function resolveDragSession(): CrossWindowModuleDragPayload | null {
  if (localDrag) return localDrag;
  if (!pointerSeed) return null;
  return ensureLocalDrag(pointerSeed.panelId, pointerSeed.sourceViewId);
}

async function broadcastDragActive(session: CrossWindowModuleDragPayload): Promise<void> {
  if (activeBroadcast) return;
  activeBroadcast = true;
  try {
    const wins = await getAllWebviewWindows();
    await Promise.all(
      wins
        .filter((w) => w.label !== session.sourceWindowLabel)
        .map((w) =>
          emitTo(w.label, CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT, session).catch(() => {}),
        ),
    );
    bridgeLog(`broadcast active from ${session.sourceWindowLabel} panel=${session.panelId}`);
  } catch (e) {
    console.warn("[moduleToWorkspaceDrag] broadcast active failed", e);
    activeBroadcast = false;
  }
}

function broadcastDragMove(
  session: CrossWindowModuleDragPayload,
  screenX: number,
  screenY: number,
): void {
  void broadcastCrossWindowDragMove({
    sourceWindowLabel: session.sourceWindowLabel,
    label: session.title?.trim() || session.panelId,
    screenX,
    screenY,
    kind: "module-tab",
  });
}

function applyIncomingModuleTab(
  targetWorkspaceId: string,
  session: CrossWindowModuleDragPayload,
): void {
  const workspace =
    useWorkspaceStore.getState().workspaces.find((w) => w.id === targetWorkspaceId) ??
    useWorkspaceStore.getState().workspace;
  const dock = useWorkspaceBottomDockStore.getState();

  let tab =
    session.serializedTab != null
      ? remapWorkspaceTabForTarget(session.serializedTab, targetWorkspaceId, session.panelId)
      : buildModuleTransferTabForWorkspace(
          targetWorkspaceId,
          session.originScope,
          session.panelId,
          session.title,
          session.params,
        );
  if (!tab) {
    bridgeLog(`apply incoming failed panel=${session.panelId} scope=${session.originScope}`);
    return;
  }

  if (tab.kind === "payload" && tab.payload) {
    if (tab.payload.module === "terminal") {
      ensureTerminalTabFromSnapshot(tab.payload);
      if (session.backendSessionId) {
        useTerminalStore.getState().setBackendSessionId(tab.payload.id, session.backendSessionId);
      }
    }
    dock.addPayloadTab(targetWorkspaceId, workspace, tab);
  } else {
    dock.addMirroredTab(targetWorkspaceId, workspace, tab as WorkspaceDockTab);
  }
  dock.setActiveTabId(targetWorkspaceId, tab.id);
  if (getCurrentWebviewWindow().label === "main") {
    useBottomPanelStore.getState().requestExpand();
  }
  requestAnimationFrame(() => {
    relayoutDockviewInstances("workspace-bottom");
  });
  bridgeLog(`applied incoming tab=${tab.id} ws=${targetWorkspaceId}`);
}

function removeOutgoingModulePanel(
  session: CrossWindowModuleDragPayload,
  targetWorkspaceId: string,
): void {
  const targetScope = `workspace-bottom-${targetWorkspaceId}`;
  const deferRemove = () => {
    const source = getDockviewInstanceByScope(session.originScope);
    if (!source) return;
    const panel = source.api.getPanel(session.panelId);
    if (!panel) return;
    source.onPanelTransferredOut?.(session.panelId, targetScope);
    try {
      source.api.removePanel(panel);
    } catch {
      // dockview 拖拽周期内可能已移除
    }
    requestAnimationFrame(() => {
      relayoutDockviewInstances(session.originScope);
    });
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(deferRemove);
  });
  bridgeLog(`scheduled remove outgoing panel=${session.panelId} scope=${session.originScope}`);
}

async function completeCrossWindowModuleTransfer(
  session: CrossWindowModuleDragPayload,
  targetLabel: string,
  targetWorkspaceId?: string | null,
): Promise<void> {
  const fallbackWorkspaceId = useWorkspaceStore.getState().workspace.id;
  const resolvedWorkspaceId =
    targetWorkspaceId ??
    resolveTargetWorkspaceIdForTransfer(targetLabel, fallbackWorkspaceId);
  if (!resolvedWorkspaceId) {
    bridgeLog(`no target workspace for label=${targetLabel}`);
    return;
  }
  if (session.sourceWindowLabel === targetLabel) return;

  const dedupeKey = transferDedupeKey(
    session.sourceWindowLabel,
    session.panelId,
    targetLabel,
  );
  if (!markTransferProcessed(dedupeKey)) {
    bridgeLog(`complete skipped duplicate ${dedupeKey}`);
    return;
  }

  const payload: CrossWindowModuleDragCompletePayload = {
    ...session,
    targetWindowLabel: targetLabel,
    targetWorkspaceId: resolvedWorkspaceId,
  };
  bridgeLog(
    `complete ${session.sourceWindowLabel} -> ${targetLabel} panel=${session.panelId}`,
  );
  await Promise.all([
    emitTo(targetLabel, CROSS_WINDOW_MODULE_DRAG_COMPLETE_EVENT, payload).catch(() => {}),
    emitTo(session.sourceWindowLabel, CROSS_WINDOW_MODULE_DRAG_COMPLETE_EVENT, payload).catch(
      () => {},
    ),
  ]);
}

async function finishModuleDragAtScreenPoint(
  screenX: number,
  screenY: number,
  clientX: number,
  clientY: number,
  currentLabel: string,
  panelId: string,
  sourceViewId: string,
  session: CrossWindowModuleDragPayload | null,
  remote: CrossWindowModuleDragPayload | null,
  finishToken: number,
): Promise<boolean> {
  if (dragCompletionLock) return false;
  if (finishToken !== dragFinishToken) return false;
  dragCompletionLock = true;
  try {
    const source = getDockviewInstance(sourceViewId);
    if (!source || !isModuleDockScope(source.scope)) return false;
    if (!isTauriRuntime()) return false;

    const targetLabel = await findWindowLabelAtScreenPoint(screenX, screenY, bridgeLog);
    if (!targetLabel || targetLabel === currentLabel) {
      return false;
    }

    const dropTarget = findModuleDropTargetWorkspace(clientX, clientY);
    const dockWorkspaceId = (() => {
      if (dropTarget?.workspaceId) return dropTarget.workspaceId;
      const dockHit = findEngineeringWorkspaceDockAt(clientX, clientY);
      if (dockHit?.scope.startsWith("workspace-bottom-")) {
        return dockHit.scope.slice("workspace-bottom-".length);
      }
      return null;
    })();

    if (remote && remote.sourceWindowLabel !== currentLabel && targetLabel === currentLabel) {
      await completeCrossWindowModuleTransfer(
        remote,
        currentLabel,
        dockWorkspaceId ?? useWorkspaceStore.getState().workspace.id,
      );
      clearRemoteDrag();
      return true;
    }

    if (session && session.sourceWindowLabel === currentLabel && targetLabel !== currentLabel) {
      if (!source.api.getPanel(panelId)) return false;
      await completeCrossWindowModuleTransfer(session, targetLabel, dockWorkspaceId);
      return true;
    }

    return false;
  } finally {
    dragCompletionLock = false;
  }
}

/**
 * 模块 dock → 工程工作区：跨 OS 窗口（主窗 ↔ 独立工作区窗）。
 * 同窗拖放由 dockview onWillDrop + transferPanelBetweenInstances 原生处理。
 */
export function initModuleToWorkspaceDragBridge(): () => void {
  const disposables: Array<{ dispose: () => void }> = [];
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragSourceViewId: string | null = null;

  const cleanupDragState = (): void => {
    if (!remoteDrag) {
      localDrag = null;
    }
    resetPointerSeed();
    dragSourceViewId = null;
    document.body.classList.remove(MODULE_DRAG_BODY_CLASS);
    void broadcastCrossWindowDragEnd();
  };

  void (async () => {
    try {
      const [{ getPanelData }, { PointerDragController }] = await Promise.all([
        import("dockview-core"),
        import("dockview-core/dist/esm/dnd/pointer/pointerDragController"),
      ]);
      if (disposed) return;

      const dragController = PointerDragController.getInstance();

      disposables.push(
        dragController.onDragStart((event) => {
          dragStartClientX = event.pointerEvent.clientX;
          dragStartClientY = event.pointerEvent.clientY;
          const data = getPanelData();
          dragSourceViewId = data?.viewId ?? null;
          if (!data?.panelId || !data.viewId) return;

          const source = getDockviewInstance(data.viewId);
          if (!source || !isModuleDockScope(source.scope)) return;

          pointerSeed = {
            panelId: data.panelId,
            sourceViewId: data.viewId,
            originScope: source.scope,
            startScreenX: event.pointerEvent.screenX,
            startScreenY: event.pointerEvent.screenY,
          };
          activeBroadcast = false;
          document.body.classList.add(MODULE_DRAG_BODY_CLASS);
          bridgeLog(`dragStart ${source.scope}:${data.panelId}`);
        }),
      );

      disposables.push(
        dragController.onDragMove((event) => {
          if (!pointerSeed) return;
          const session = ensureLocalDrag(pointerSeed.panelId, pointerSeed.sourceViewId);
          if (session && isTauriRuntime()) {
            void broadcastDragActive(session);
            broadcastDragMove(session, event.pointerEvent.screenX, event.pointerEvent.screenY);
          }
        }),
      );

      disposables.push(
        dragController.onDragEnd(() => {
          if (!pointerSeed && !localDrag) {
            cleanupDragState();
          }
        }),
      );

      bridgeLog("pointer bridge attached");
    } catch (e) {
      console.warn("[moduleToWorkspaceDrag] pointer bridge unavailable", e);
    }
  })();

  const onPointerMove = (event: PointerEvent) => {
    if (!(event.buttons & 1)) return;
    if (!pointerSeed && !isModuleDockDragActive()) return;

    if (pointerSeed && pointerSeed.startScreenX === 0 && pointerSeed.startScreenY === 0) {
      pointerSeed.startScreenX = event.screenX;
      pointerSeed.startScreenY = event.screenY;
    }

    if (!pointerSeed) return;
    const movedEnough =
      pointerSeed.startScreenX === 0 ||
      Math.hypot(event.screenX - pointerSeed.startScreenX, event.screenY - pointerSeed.startScreenY) >=
        DRAG_THRESHOLD_PX ||
      isModuleDockDragActive();
    if (!movedEnough) return;

    const session = ensureLocalDrag(pointerSeed.panelId, pointerSeed.sourceViewId);
    if (session && isTauriRuntime()) {
      void broadcastDragActive(session);
      broadcastDragMove(session, event.screenX, event.screenY);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const remote =
      remoteDrag && remoteDrag.expiresAt > Date.now() ? remoteDrag : null;

    if (!remote && !pointerSeed && !localDrag && !isModuleDockDragActive()) {
      return;
    }

    if (!remote && !dragMovedEnoughAt(event.screenX, event.screenY)) {
      cleanupDragState();
      return;
    }

    void (async () => {
      const currentLabel = isTauriRuntime()
        ? getCurrentWebviewWindow().label
        : "main";

      if (!remote && isTauriRuntime()) {
        const targetLabel = await findWindowLabelAtScreenPoint(
          event.screenX,
          event.screenY,
          bridgeLog,
        );
        if (!targetLabel || targetLabel === currentLabel) {
          // 同窗：dockview onWillDrop → transferPanelBetweenInstances 原生处理
          return;
        }
      } else if (!remote && !isTauriRuntime()) {
        return;
      }

      const panelId = pointerSeed?.panelId ?? panelIdFromActiveModuleDrag();
      let sourceViewId = dragSourceViewId ?? pointerSeed?.sourceViewId ?? null;
      if (!sourceViewId && panelId) {
        sourceViewId = findModuleDockPanelById(panelId)?.viewId ?? null;
      }
      if (!panelId || !sourceViewId) return;

      const session = resolveDragSession();
      const finishToken = ++dragFinishToken;

      event.preventDefault();
      event.stopImmediatePropagation();

      await finishModuleDragAtScreenPoint(
        event.screenX,
        event.screenY,
        event.clientX,
        event.clientY,
        currentLabel,
        panelId,
        sourceViewId,
        session,
        remote,
        finishToken,
      );
    })()
      .catch((e) => {
        console.warn("[moduleToWorkspaceDrag] pointerup failed", e);
      })
      .finally(cleanupDragState);
  };

  const observer = new MutationObserver(() => {
    if (!isModuleDockDragActive() || !pointerSeed) return;
    const session = ensureLocalDrag(pointerSeed.panelId, pointerSeed.sourceViewId);
    if (session && isTauriRuntime()) {
      void broadcastDragActive(session);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  const onTabGrab = (event: Event) => {
    const detail = (event as CustomEvent<{
      panelId?: string;
      dockScope?: string;
      screenX?: number;
      screenY?: number;
    }>).detail;
    const panelId = detail?.panelId;
    if (!panelId) return;
    seedPointerFromModulePanelId(
      panelId,
      detail.dockScope,
      detail.screenX ?? 0,
      detail.screenY ?? 0,
    );
  };

  window.addEventListener(MODULE_DOCK_TAB_GRAB_EVENT, onTabGrab);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);

  if (isTauriRuntime()) {
    void listen<CrossWindowModuleDragPayload>(
      CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (payload.sourceWindowLabel === getCurrentWebviewWindow().label) return;
        remoteDrag = { ...payload, expiresAt: Date.now() + REMOTE_DRAG_TTL_MS };
        document.body.classList.add(MODULE_DRAG_BODY_CLASS);
        bridgeLog(`remote active from ${payload.sourceWindowLabel}`);
      },
      { target: { kind: "Any" } },
    ).then((fn) => unlisteners.push(fn));

    void listen<CrossWindowModuleDragCompletePayload>(
      CROSS_WINDOW_MODULE_DRAG_COMPLETE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        const currentLabel = getCurrentWebviewWindow().label;
        bridgeLog(
          `complete event current=${currentLabel} src=${payload.sourceWindowLabel} tgt=${payload.targetWindowLabel}`,
        );
        if (payload.targetWindowLabel === currentLabel) {
          applyIncomingModuleTab(payload.targetWorkspaceId, payload);
        }
        if (payload.sourceWindowLabel === currentLabel) {
          removeOutgoingModulePanel(payload, payload.targetWorkspaceId);
        }
        document.body.classList.remove(MODULE_DRAG_BODY_CLASS);
        localDrag = null;
        resetPointerSeed();
        if (remoteDrag?.sourceWindowLabel === payload.sourceWindowLabel) {
          clearRemoteDrag();
        }
        void broadcastCrossWindowDragEnd();
      },
      { target: { kind: "Any" } },
    ).then((fn) => unlisteners.push(fn));
  }

  return () => {
    disposed = true;
    observer.disconnect();
    for (const d of disposables) d.dispose();
    window.removeEventListener(MODULE_DOCK_TAB_GRAB_EVENT, onTabGrab);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    for (const fn of unlisteners) safeTauriUnlisten(fn);
    document.body.classList.remove(MODULE_DRAG_BODY_CLASS);
    pointerSeed = null;
    localDrag = null;
    clearRemoteDrag();
    activeBroadcast = false;
    dragCompletionLock = false;
    dragFinishToken = 0;
    recentTransferKeys.clear();
  };
}
