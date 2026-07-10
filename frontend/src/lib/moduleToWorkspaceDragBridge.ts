import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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
import {
  clearWebviewWindowLabelCache,
  emitToOtherWebviews,
  findWindowLabelAtScreenPoint,
  isPointerOutsideCurrentWindow,
  isWindowChromePointerTarget,
  resolveTargetWorkspaceIdForTransfer,
  screenPointToClient,
} from "./crossWindowDragUtils";
import {
  bindDockviewPointerDragController,
  cancelDockviewPointerDrag,
  forceEndDockviewPointerDrag,
} from "./dockviewPointerDrag";
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
  CROSS_WINDOW_DRAG_END_EVENT,
  useCrossWindowDragVisualStore,
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
const DRAG_COMPLETION_LOCK_TIMEOUT_MS = 800;
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
let dragCompletionLockTimer: ReturnType<typeof setTimeout> | null = null;
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

function clearLocalModuleDockDragArtifacts(): void {
  document
    .querySelectorAll(
      ".dockable-workspace:not(.workspace-panel-dock) .dv-tab-dragging, .dockable-workspace:not(.workspace-panel-dock) .dv-tab--dragging, .dockable-workspace:not(.workspace-panel-dock) .dv-resize-container-dragging",
    )
    .forEach((el) => {
      el.classList.remove(
        "dv-tab-dragging",
        "dv-tab--dragging",
        "dv-resize-container-dragging",
      );
    });
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
  bridgeLog(`grab ${found.scope}:${panelId}`);
  return true;
}

function dragMovedEnoughAt(screenX: number, screenY: number): boolean {
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (localDrag) return true;
  if (!pointerSeed) {
    return isModuleDockDragActive() && Boolean(panelIdFromActiveModuleDrag());
  }
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

function acquireDragCompletionLock(): void {
  dragCompletionLock = true;
  if (dragCompletionLockTimer) {
    clearTimeout(dragCompletionLockTimer);
  }
  dragCompletionLockTimer = setTimeout(() => {
    dragCompletionLock = false;
    dragCompletionLockTimer = null;
    bridgeLog("dragCompletionLock timeout released");
  }, DRAG_COMPLETION_LOCK_TIMEOUT_MS);
}

function releaseDragCompletionLock(): void {
  dragCompletionLock = false;
  if (dragCompletionLockTimer) {
    clearTimeout(dragCompletionLockTimer);
    dragCompletionLockTimer = null;
  }
}

function hasStaleModuleDragSession(): boolean {
  if (localDrag || activeBroadcast) return true;
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (document.body.classList.contains(MODULE_DRAG_BODY_CLASS)) return true;
  const visual = useCrossWindowDragVisualStore.getState();
  if (visual.active && !pointerSeed && !isModuleDockDragActive()) return true;
  return false;
}

function resetModuleDragSession(options?: { broadcastEnd?: boolean }): void {
  const shouldBroadcast =
    options?.broadcastEnd ??
    Boolean(
      activeBroadcast ||
        localDrag ||
        document.body.classList.contains(MODULE_DRAG_BODY_CLASS) ||
        useCrossWindowDragVisualStore.getState().active,
    );
  if (!remoteDrag) {
    localDrag = null;
  }
  resetPointerSeed();
  clearRemoteDrag();
  clearLocalModuleDockDragArtifacts();
  document.body.classList.remove(MODULE_DRAG_BODY_CLASS);
  releaseDragCompletionLock();
  clearWebviewWindowLabelCache();
  if (shouldBroadcast) {
    void broadcastCrossWindowDragEnd();
  }
}

async function broadcastDragActive(
  session: CrossWindowModuleDragPayload,
  screenX = 0,
  screenY = 0,
): Promise<void> {
  if (activeBroadcast) return;
  activeBroadcast = true;
  try {
    const current = getCurrentWebviewWindow().label;
    await emitToOtherWebviews(
      CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT,
      {
        ...session,
        screenX,
        screenY,
      },
      current,
    );
    bridgeLog(`broadcast active from ${session.sourceWindowLabel} panel=${session.panelId}`);
  } catch (e) {
    console.warn("[moduleToWorkspaceDrag] broadcast active failed", e);
    activeBroadcast = false;
  }
}

function broadcastModuleDragMove(
  session: CrossWindowModuleDragPayload,
  screenX: number,
  screenY: number,
): void {
  broadcastCrossWindowDragMove({
    sourceWindowLabel: session.sourceWindowLabel,
    label: session.title?.trim() || session.panelId,
    screenX,
    screenY,
    kind: "module-tab",
  });
}

function maybeBroadcastModuleActiveOnMove(
  session: CrossWindowModuleDragPayload,
  screenX: number,
  screenY: number,
): void {
  void broadcastDragActive(session, screenX, screenY);
  broadcastModuleDragMove(session, screenX, screenY);
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
    cancelDockviewPointerDrag();
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
  knownTargetLabel?: string | null,
): Promise<boolean> {
  if (dragCompletionLock) return false;
  if (finishToken !== dragFinishToken) return false;
  acquireDragCompletionLock();
  try {
    if (!isTauriRuntime()) return false;

    const targetLabel =
      knownTargetLabel ??
      (isPointerOutsideCurrentWindow(screenX, screenY)
        ? await findWindowLabelAtScreenPoint(screenX, screenY, bridgeLog, currentLabel)
        : currentLabel);
    if (!targetLabel) {
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

    if (targetLabel === currentLabel) {
      return false;
    }

    const source = getDockviewInstance(sourceViewId);
    if (!source || !isModuleDockScope(source.scope)) return false;

    if (session && session.sourceWindowLabel === currentLabel && targetLabel !== currentLabel) {
      if (!source.api.getPanel(panelId)) return false;
      await completeCrossWindowModuleTransfer(session, targetLabel, dockWorkspaceId);
      return true;
    }

    return false;
  } finally {
    releaseDragCompletionLock();
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

  const quietAbortDrag = (): void => {
    cancelDockviewPointerDrag();
    dragSourceViewId = null;
    resetModuleDragSession({ broadcastEnd: activeBroadcast });
  };

  const cleanupDragState = (): void => {
    cancelDockviewPointerDrag();
    dragSourceViewId = null;
    resetModuleDragSession({ broadcastEnd: true });
  };

  void (async () => {
    try {
      const [{ getPanelData }, { PointerDragController }] = await Promise.all([
        import("dockview-core"),
        import("dockview-core/dist/esm/dnd/pointer/pointerDragController"),
      ]);
      if (disposed) return;

      const dragController = PointerDragController.getInstance();
      bindDockviewPointerDragController(dragController);

      disposables.push(
        dragController.onDragStart((event) => {
          dragStartClientX = event.pointerEvent.clientX;
          dragStartClientY = event.pointerEvent.clientY;
          const data = getPanelData();
          dragSourceViewId = data?.viewId ?? null;
          if (!data?.panelId || !data.viewId) return;

          const source = getDockviewInstance(data.viewId);
          if (!source || !isModuleDockScope(source.scope)) return;

          dragFinishToken += 1;
          if (hasStaleModuleDragSession()) {
            resetModuleDragSession({ broadcastEnd: true });
          }

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
            maybeBroadcastModuleActiveOnMove(
              session,
              event.pointerEvent.screenX,
              event.pointerEvent.screenY,
            );
          }
        }),
      );

      disposables.push(
        dragController.onDragEnd(() => {
          if (!pointerSeed && !localDrag) {
            quietAbortDrag();
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
    // dockview 拖拽中也要续发 MOVE，否则出窗后目标窗 ghost 停更
    if (!pointerSeed && !localDrag) return;

    if (pointerSeed) {
      if (pointerSeed.startScreenX === 0 && pointerSeed.startScreenY === 0) {
        pointerSeed.startScreenX = event.screenX;
        pointerSeed.startScreenY = event.screenY;
      }
    }

    const movedEnough =
      !pointerSeed ||
      pointerSeed.startScreenX === 0 ||
      Math.hypot(
        event.screenX - pointerSeed.startScreenX,
        event.screenY - pointerSeed.startScreenY,
      ) >= DRAG_THRESHOLD_PX ||
      isModuleDockDragActive() ||
      isPointerOutsideCurrentWindow(event.screenX, event.screenY);

    if (!movedEnough) return;

    const session =
      localDrag ??
      (pointerSeed
        ? ensureLocalDrag(pointerSeed.panelId, pointerSeed.sourceViewId)
        : null);
    if (session && isTauriRuntime()) {
      maybeBroadcastModuleActiveOnMove(session, event.screenX, event.screenY);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (isWindowChromePointerTarget(event.target)) {
      quietAbortDrag();
      return;
    }

    const remote =
      remoteDrag && remoteDrag.expiresAt > Date.now() ? remoteDrag : null;

    if (!remote && !pointerSeed && !localDrag && !isModuleDockDragActive()) {
      return;
    }

    if (!remote && !dragMovedEnoughAt(event.screenX, event.screenY)) {
      quietAbortDrag();
      return;
    }

    const currentLabel = isTauriRuntime()
      ? getCurrentWebviewWindow().label
      : "main";

    const outside = isPointerOutsideCurrentWindow(event.screenX, event.screenY);
    if (remote || outside) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelDockviewPointerDrag();
    }

    if (!remote && !outside) {
      resetModuleDragSession({ broadcastEnd: activeBroadcast });
      return;
    }

    const panelId = pointerSeed?.panelId ?? panelIdFromActiveModuleDrag();
    let sourceViewId = dragSourceViewId ?? pointerSeed?.sourceViewId ?? null;
    if (!sourceViewId && panelId) {
      sourceViewId = findModuleDockPanelById(panelId)?.viewId ?? null;
    }

    const finishToken = ++dragFinishToken;

    void (async (): Promise<boolean | "aborted"> => {
      let knownTarget: string | null = null;
      if (!remote) {
        knownTarget = await findWindowLabelAtScreenPoint(
          event.screenX,
          event.screenY,
          bridgeLog,
          currentLabel,
        );
        if (finishToken !== dragFinishToken) return "aborted";
        if (!knownTarget || knownTarget === currentLabel) {
          resetModuleDragSession({ broadcastEnd: activeBroadcast });
          return "aborted";
        }
      }

      if (!remote && (!panelId || !sourceViewId)) {
        quietAbortDrag();
        return "aborted";
      }

      const session = resolveDragSession();
      if (!session && !remote) {
        quietAbortDrag();
        return "aborted";
      }

      return finishModuleDragAtScreenPoint(
        event.screenX,
        event.screenY,
        event.clientX,
        event.clientY,
        currentLabel,
        panelId ?? remote?.panelId ?? "",
        sourceViewId ?? "",
        session,
        remote,
        finishToken,
        knownTarget,
      );
    })()
      .catch((e) => {
        console.warn("[moduleToWorkspaceDrag] pointerup failed", e);
        return false as boolean | "aborted";
      })
      .then((result) => {
        if (result === "aborted") return;
        if (finishToken !== dragFinishToken) return;
        cleanupDragState();
      });
  };

  const onTabGrab = (event: Event) => {
    const detail = (event as CustomEvent<{
      panelId?: string;
      dockScope?: string;
      screenX?: number;
      screenY?: number;
    }>).detail;
    const panelId = detail?.panelId;
    if (!panelId) return;
    dragFinishToken += 1;
    if (hasStaleModuleDragSession()) {
      resetModuleDragSession({ broadcastEnd: true });
    }
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
    void listen(CROSS_WINDOW_DRAG_END_EVENT, () => {
      forceEndDockviewPointerDrag();
      clearRemoteDrag();
      document.body.classList.remove(MODULE_DRAG_BODY_CLASS);
    }, { target: { kind: "Any" } }).then((fn) => unlisteners.push(fn));

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
        forceEndDockviewPointerDrag();
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
    for (const d of disposables) d.dispose();
    window.removeEventListener(MODULE_DOCK_TAB_GRAB_EVENT, onTabGrab);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    for (const fn of unlisteners) safeTauriUnlisten(fn);
    resetModuleDragSession({ broadcastEnd: false });
    dragSourceViewId = null;
    recentTransferKeys.clear();
    dragFinishToken = 0;
  };
}
