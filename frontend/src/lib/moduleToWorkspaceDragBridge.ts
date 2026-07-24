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
  findOtherWindowHitSync,
  findTopmostWindowHitSync,
  findWindowLabelAtScreenPoint,
  getSoleOtherWindowLabelSync,
  isPointerOutsideCurrentWindow,
  isWindowChromePointerTarget,
  primeWindowBoundsCache,
  resolveTargetWorkspaceIdForTransfer,
} from "./crossWindowDragUtils";
import {
  cancelDockviewPointerDrag,
  forceEndDockviewPointerDrag,
} from "./dockviewPointerDrag";
import { isTauriRuntime } from "./isTauriRuntime";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import { sendTabStateTransfer } from "./tabStateTransfer";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useWorkspaceBottomDockStore, MAX_WORKSPACE_PANELS, type WorkspaceDockTab } from "../stores/workspaceBottomDockStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { ensureTerminalTabFromSnapshot } from "./workspaceTabActions";
import {
  broadcastCrossWindowDragEnd,
  broadcastCrossWindowDragEndLite,
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
  // 开启：localStorage.setItem("omnipanel-cross-dock-debug", "1")
  if (
    typeof localStorage === "undefined" ||
    localStorage.getItem("omnipanel-cross-dock-debug") !== "1"
  ) {
    return;
  }
  // eslint-disable-next-line no-console
  console.info(`[moduleToWorkspaceDrag] ${message}`);
}

// 高频路径（pointermove broadcast）专用采样日志
function bridgeLogSampled(message: string): void {
  if (
    typeof localStorage === "undefined" ||
    localStorage.getItem("omnipanel-cross-dock-debug") !== "1"
  ) {
    return;
  }
  const now = Date.now();
  if (now - lastBridgeLogAt < 200) return;
  lastBridgeLogAt = now;
  // eslint-disable-next-line no-console
  console.info(`[moduleToWorkspaceDrag] ${message}`);
}

let lastBridgeLogAt = 0;

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

function dragMovedEnoughAt(_screenX: number, _screenY: number): boolean {
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (localDrag) return true;
  if (!pointerSeed) {
    return isModuleDockDragActive() && Boolean(panelIdFromActiveModuleDrag());
  }
  // pointerSeed 存在意味着 onTabGrab 成功触发拖拽，直接返回 true。
  // 不依赖 isModuleDockDragActive()（dragging class 可能被 resetModuleDragSession 移除），
  // 否则会在 onPointerUp 时误判为"未移动足够距离"，走 quietAbortDrag →
  // cancelDockviewPointerDrag → 派发 pointercancel → dockview _teardown →
  // _upListener 被 dispose，pointerup 不触发 handleDrop（分屏失效）。
  return true;
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

function resetModuleDragSession(options?: {
  broadcastEnd?: boolean;
  /** true = 只清理跨窗视觉层 + 发 END，不 forceEndDockviewPointerDrag / 不清 dockview artifacts。
   * 用于同窗口内 drop：让 dockview 自己完成原生 drop（分屏等）。 */
  lite?: boolean;
}): void {
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
    if (options?.lite) {
      void broadcastCrossWindowDragEndLite();
    } else {
      void broadcastCrossWindowDragEnd();
    }
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
    // 仅当指针已离开源窗几何时才计算命中目标。
    // 指针在源窗内时 targetLabel=null：源窗在顶层，不应有目标窗激活。
    const outside = isPointerOutsideCurrentWindow(screenX, screenY);
    let targetLabel: string | null = null;
    if (outside) {
      targetLabel = findOtherWindowHitSync(screenX, screenY, current);
      if (!targetLabel) {
        targetLabel = getSoleOtherWindowLabelSync(current);
      }
    }
    await emitToOtherWebviews(
      CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT,
      {
        ...session,
        screenX,
        screenY,
        targetLabel,
      },
      current,
    );
    bridgeLogSampled(`broadcast active from ${session.sourceWindowLabel} panel=${session.panelId} target=${targetLabel}`);
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
  const beforeCount = dock.tabsByWorkspace[targetWorkspaceId]?.length ?? 0;
  bridgeLog(
    `applyIncoming enter ws=${targetWorkspaceId} panel=${session.panelId} scope=${session.originScope} beforeCount=${beforeCount} max=${MAX_WORKSPACE_PANELS}`,
  );

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
    const { kind: _kind, ...payloadTab } = tab;
    dock.addPayloadTab(targetWorkspaceId, workspace, {
      ...payloadTab,
      payload: tab.payload,
    });
  } else {
    const { kind: _kind, payload: _payload, ...mirroredTab } = tab;
    dock.addMirroredTab(targetWorkspaceId, workspace, mirroredTab);
  }
  const afterCount = useWorkspaceBottomDockStore.getState().tabsByWorkspace[targetWorkspaceId]?.length ?? 0;
  const addedOk = afterCount === beforeCount + 1 || afterCount === beforeCount; // existing tab 不会增长
  bridgeLog(
    `applyIncoming addResult kind=${tab.kind} before=${beforeCount} after=${afterCount} addedOk=${addedOk}`,
  );
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
  const isDisposed = () => disposed;
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

  // dockview PointerDragController 未从主入口导出，子路径导入会得到另一个独立单例，
  // onDragStart/onDragMove/onDragEnd 订阅永远不会触发。
  // drag 检测改用 MODULE_DOCK_TAB_GRAB_EVENT + document pointermove/pointerup
  // （下面注册），ghost 收口改用 dockviewPointerDrag 派发的 pointercancel。

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
    // 重叠场景：指针仍在源窗几何内（outside=false），但可能有其他窗口覆盖在源窗之上。
    // 用 z-order 找最顶层命中窗口：如果最顶层是源窗，留在源窗；否则跨窗到覆盖窗口。
    let overlapHit: string | null = null;
    if (!outside && !remote) {
      const topmost = findTopmostWindowHitSync(event.screenX, event.screenY);
      if (topmost && topmost !== currentLabel) {
        // 关键：指针在源窗几何内（outside=false），同时源窗内有 workspace dock 命中，
        // 说明用户是要拖到同窗的半屏 workspace dock（而非跨窗到独立 workspace 窗口）。
        // 独立 workspace 窗口的 bounds 可能与主窗下方半屏区域重叠导致 topmost 误判，
        // 此处必须优先走同窗 dockview 原生 onWillDrop 路径，否则 tab 会因跨窗转移失败而丢失。
        const localDropTarget = findModuleDropTargetWorkspace(event.clientX, event.clientY);
        if (!localDropTarget) {
          overlapHit = topmost;
        } else {
          bridgeLog(
            `overlapHit suppressed topmost=${topmost} -> local workspace dock hit ws=${localDropTarget.workspaceId}`,
          );
        }
      }
    }
    const isCrossWindow = remote || outside || overlapHit !== null;
    bridgeLog(
      `pointerup on=${currentLabel} screen=(${event.screenX},${event.screenY}) outside=${outside} overlapHit=${overlapHit} remote=${remote ? remote.sourceWindowLabel : "null"} isCrossWindow=${isCrossWindow}`,
    );

    if (isCrossWindow) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelDockviewPointerDrag();
    }

    if (!isCrossWindow) {
      // 同窗口内 drop：完全交给 dockview 自己处理（分屏等）。
      // 只清理本模块的指针种子/广播标志，**不**触碰 dockview DOM / store / pointercancel。
      // 任何同步/异步清理都可能干扰 dockview _handleEnd → handleDrop → moveGroupOrPanel。
      const wasBroadcasting = activeBroadcast;
      resetPointerSeed();
      localDrag = null;
      clearRemoteDrag();
      releaseDragCompletionLock();
      if (wasBroadcasting) {
        queueMicrotask(() => {
          void import("./crossWindowDragVisual").then(({ broadcastCrossWindowDragEndLite }) =>
            broadcastCrossWindowDragEndLite()
          );
        });
      }
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
    // 预热窗口几何缓存，确保 pointerup 同步阶段的 findOtherWindowHitSync 有数据
    void primeWindowBoundsCache();
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
    }, { target: { kind: "Any" } }).then((fn) => {
    if (isDisposed()) {
      safeTauriUnlisten(fn);
      return;
    }
    unlisteners.push(fn);
  });

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
    ).then((fn) => {
      if (isDisposed()) {
        safeTauriUnlisten(fn);
        return;
      }
      unlisteners.push(fn);
    });

    void listen<CrossWindowModuleDragCompletePayload>(
      CROSS_WINDOW_MODULE_DRAG_COMPLETE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        const currentLabel = getCurrentWebviewWindow().label;
        bridgeLog(
          `complete event current=${currentLabel} src=${payload.sourceWindowLabel} tgt=${payload.targetWindowLabel}`,
        );

        // 去重：StrictMode / listen 异步泄漏可能导致同一 COMPLETE 事件被多次接收
        const recvDedupeKey = `recv|${payload.sourceWindowLabel}|${payload.panelId}|${payload.targetWindowLabel}`;
        if (!markTransferProcessed(recvDedupeKey)) {
          bridgeLog(`complete event skipped duplicate ${recvDedupeKey}`);
          return;
        }

        forceEndDockviewPointerDrag();
        if (payload.targetWindowLabel === currentLabel) {
          applyIncomingModuleTab(payload.targetWorkspaceId, payload);
        }
        if (payload.sourceWindowLabel === currentLabel) {
          // 跨窗口转移 tab 运行时状态（终端历史 / SQL 文本 / 查询结果等）
          // 必须在 removeOutgoingModulePanel 之前收集，否则源端 store 数据可能被清理
          const moduleType =
            payload.originScope === "terminal"
              ? "terminal"
              : payload.originScope === "database"
                ? "database"
                : null;
          if (moduleType === "terminal" || moduleType === "database") {
            const sessionId =
              moduleType === "terminal"
                ? useTerminalStore.getState().tabs.find((t) => t.id === payload.panelId)?.sessionId
                : undefined;
            const dbTabId =
              moduleType === "database"
                ? `workspace-bottom-${payload.targetWorkspaceId}:${payload.panelId}`
                : undefined;
            void sendTabStateTransfer(
              payload.targetWindowLabel,
              payload.panelId,
              moduleType,
              sessionId,
              dbTabId,
            ).catch(() => {});
          }
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
    ).then((fn) => {
      if (isDisposed()) {
        safeTauriUnlisten(fn);
        return;
      }
      unlisteners.push(fn);
    });
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
