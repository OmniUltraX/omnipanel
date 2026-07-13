import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import {
  clearWebviewWindowLabelCache,
  emitToOtherWebviews,
  findOtherWindowHitSync,
  findTopmostWindowHitSync,
  findWindowLabelAtScreenPoint,
  isPointerOutsideCurrentWindow,
  isWindowChromePointerTarget,
  primeWindowBoundsCache,
  resolveTargetWorkspaceIdForTransfer,
  screenPointToClient,
} from "./crossWindowDragUtils";
import {
  cancelDockviewPointerDrag,
  forceEndDockviewPointerDrag,
} from "./dockviewPointerDrag";
import {
  applyCrossWindowWorkspaceTabToModule,
  findModuleDropTargetWorkspace,
  isModuleDockScope,
  resolveTerminalIdFromWorkspacePanel,
} from "./moduleToWorkspaceTransfer";
import {
  useWorkspaceBottomDockStore,
  type WorkspaceDockTab,
} from "../stores/workspaceBottomDockStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useTerminalStore } from "../stores/terminalStore";
import { cleanupWorkspaceDockTab, ensureTerminalTabFromSnapshot, moveTerminalTabToWorkspaceSnapshot } from "./workspaceTabActions";
import { isTauriRuntime } from "./isTauriRuntime";
import {
  findEngineeringWorkspaceDockAt,
  findModuleDockAt,
  relayoutDockviewInstances,
  getDockviewInstanceByScope,
  requestDockScopeResync,
} from "./dockviewRegistry";
import { isWorkspacePoppedOut, useWorkspaceWindowStore } from "../stores/workspaceWindowStore";
import { useBottomPanelStore } from "../stores/bottomPanelStore";
import { workspaceIdFromLabel } from "./workspaceWindow";
import { MODULE_PATHS } from "./paths";
import {
  broadcastCrossWindowDragEnd,
  broadcastCrossWindowDragEndLite,
  broadcastCrossWindowDragMove,
  CROSS_WINDOW_DRAG_END_EVENT,
  updateLocalOutboundDragVisual,
  useCrossWindowDragVisualStore,
} from "./crossWindowDragVisual";

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
  /** 源窗侧可能未知；由目标窗 WebView 在落点解析 */
  targetWorkspaceId: string | null;
  dropScreenX: number;
  dropScreenY: number;
  /** module：落入模块 dock；workspace：落入工程工作区 dock */
  transferTarget?: "workspace" | "module";
  targetModuleScope?: string;
}

/** 防止 HMR 重复注册监听器 */
let crossWindowDockTransferCleanup: (() => void) | null = null;

function isTerminalWorkspaceTab(tab: WorkspaceDockTab): boolean {
  if (tab.kind === "payload" && tab.payload?.module === "terminal") return true;
  return (
    tab.kind === "mirrored" &&
    (tab.originScope === "terminal" || tab.panelType === "terminal")
  );
}

function isDropOverTerminalModuleArea(clientX: number, clientY: number): boolean {
  const elements = document.elementsFromPoint(clientX, clientY);
  for (const el of elements) {
    if (
      el.closest(
        ".workspace-bottom-host, .workspace-panel-dock, .workspace-panel-frame, .dock-panel-bottom--workspace",
      )
    ) {
      return false;
    }
    if (el.closest(".terminal-module-dock, .term-sessions-workspace")) {
      return true;
    }
  }
  return false;
}

function emitSourceCleanup(
  payload: CrossWindowDockDragCompletePayload,
  transferTarget: "module" | "workspace",
  extra?: Partial<CrossWindowDockDragCompletePayload>,
): void {
  void emitTo(payload.sourceWindowLabel, CROSS_WINDOW_DOCK_SOURCE_CLEANUP_EVENT, {
    ...payload,
    transferTarget,
    ...extra,
  }).catch(() => {});
}
const REMOTE_DRAG_TTL_MS = 30_000;
const DRAG_THRESHOLD_PX = 4;
const DRAG_COMPLETION_LOCK_TIMEOUT_MS = 800;
const WORKSPACE_DOCK_SELECTOR = ".workspace-panel-dock";
const WORKSPACE_DOCK_SCOPE_PREFIX = "workspace-bottom-";

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
let dragCompletionLockTimer: ReturnType<typeof setTimeout> | null = null;
let dragFinishToken = 0;
const recentTransferKeys = new Set<string>();
/** 跨窗拖出进行中：阻止 dockview onDidRemovePanel 提前销毁 store 中的 tab */
const pendingOutboundPanelIds = new Set<string>();

export function isWorkspaceDockOutboundTransfer(panelId: string): boolean {
  return pendingOutboundPanelIds.has(panelId);
}

function trackOutboundPanel(panelId: string): void {
  pendingOutboundPanelIds.add(panelId);
}

function untrackOutboundPanel(panelId: string): void {
  pendingOutboundPanelIds.delete(panelId);
}

function maybeResyncOutboundDock(session: CrossWindowDockDragPayload | null): void {
  if (!session) return;
  const scope = `${WORKSPACE_DOCK_SCOPE_PREFIX}${session.sourceWorkspaceId}`;
  const tabs =
    useWorkspaceBottomDockStore.getState().tabsByWorkspace[session.sourceWorkspaceId] ?? [];
  if (!tabs.some((item) => item.id === session.panelId)) {
    untrackOutboundPanel(session.panelId);
    return;
  }
  const inst = getDockviewInstanceByScope(scope);
  if (inst?.api?.getPanel(session.panelId)) {
    untrackOutboundPanel(session.panelId);
    return;
  }
  requestDockScopeResync(scope);
  untrackOutboundPanel(session.panelId);
}

function scheduleOutboundDockRecovery(
  session: CrossWindowDockDragPayload | null,
  transferCompleted: boolean,
): void {
  if (!session) return;
  if (!transferCompleted) {
    maybeResyncOutboundDock(session);
    return;
  }
  window.setTimeout(() => maybeResyncOutboundDock(session), 120);
}

function cloneWorkspaceDockTab(tab: WorkspaceDockTab): WorkspaceDockTab {
  return structuredClone(tab);
}

/** 跨窗拖出前将镜像终端 tab 转为带 snapshot 的 payload，便于目标窗重建会话。 */
function normalizeTabForCrossWindowTransfer(tab: WorkspaceDockTab): WorkspaceDockTab {
  if (tab.kind === "payload" && tab.payload?.module === "terminal") {
    return tab;
  }
  if (!isTerminalWorkspaceTab(tab)) {
    return tab;
  }
  const terminalId = resolveTerminalIdFromWorkspacePanel(
    tab.originPanelId ?? tab.id,
    tab.originScope,
  );
  if (!terminalId) return tab;
  const sourceTab = useTerminalStore.getState().tabs.find((item) => item.id === terminalId);
  if (!sourceTab) return tab;
  const snapshot = moveTerminalTabToWorkspaceSnapshot(sourceTab);
  return {
    ...tab,
    kind: "payload",
    payload: snapshot,
    originScope: tab.originScope ?? "terminal",
    originPanelId: terminalId,
    panelType: "terminal",
  };
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

function crossDockLog(message: string): void {
  if (!import.meta.env.DEV) return;
  console.info(`[crossWindowDock] ${message}`);
}

function isWorkspaceDockElement(el: Element | null | undefined): boolean {
  return Boolean(el?.closest(WORKSPACE_DOCK_SELECTOR));
}

function clearLocalWorkspaceDockDragArtifacts(): void {
  document
    .querySelectorAll(
      `${WORKSPACE_DOCK_SELECTOR} .dv-tab-dragging, ${WORKSPACE_DOCK_SELECTOR} .dv-tab--dragging, ${WORKSPACE_DOCK_SELECTOR} .dv-resize-container-dragging`,
    )
    .forEach((el) => {
      el.classList.remove(
        "dv-tab-dragging",
        "dv-tab--dragging",
        "dv-resize-container-dragging",
      );
    });
}

function dragMovedEnoughAt(screenX: number, screenY: number): boolean {
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (localDrag) return true;
  if (!pointerSeed) {
    return isWorkspaceDockDragActive() && Boolean(panelIdFromActiveDrag());
  }
  // pointerSeed 存在意味着 onTabGrab 成功触发拖拽，直接返回 true。
  // 不依赖 isWorkspaceDockDragActive()（dragging class 可能被 resetDragSession 移除），
  // 否则会在 onPointerUp 时误判为"未移动足够距离"，走 quietAbortDrag →
  // cancelDockviewPointerDrag → 派发 pointercancel → dockview _teardown →
  // _upListener 被 dispose，pointerup 不触发 handleDrop（分屏失效）。
  return true;
}

function buildDragSessionFromSeed(seed: PointerDragSeed): CrossWindowDockDragPayload {
  return {
    sourceWindowLabel: getCurrentWebviewWindow().label,
    sourceWorkspaceId: seed.workspaceId,
    panelId: seed.panelId,
    tab: seed.tab,
    backendSessionId: backendSessionIdForTab(seed.tab),
  };
}

function resolveDragSession(): CrossWindowDockDragPayload | null {
  if (localDrag) return localDrag;
  if (pointerSeed) return buildDragSessionFromSeed(pointerSeed);
  const panelId = panelIdFromActiveDrag();
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
    tab: normalizeTabForCrossWindowTransfer(cloneWorkspaceDockTab(found.tab)),
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
  const normalizedTab = normalizeTabForCrossWindowTransfer(cloneWorkspaceDockTab(found.tab));
  trackOutboundPanel(panelId);
  localDrag = {
    sourceWindowLabel: getCurrentWebviewWindow().label,
    sourceWorkspaceId: found.workspaceId,
    panelId,
    tab: normalizedTab,
    backendSessionId: backendSessionIdForTab(normalizedTab),
  };
  return localDrag;
}

/** 主窗实际挂载、可接收拖放的工程工作区（全屏 B 时 store 可能仍指向已弹出的 A） */
function resolveMainWindowHostedWorkspaceId(
  clientX: number,
  clientY: number,
): string | null {
  const poppedOut = useWorkspaceWindowStore.getState().poppedOutIds;
  const hosted = useWorkspaceStore
    .getState()
    .workspaces.filter((ws) => !poppedOut.includes(ws.id));
  if (hosted.length === 0) return null;

  const workspaceDock = findEngineeringWorkspaceDockAt(clientX, clientY);
  if (workspaceDock?.scope.startsWith(WORKSPACE_DOCK_SCOPE_PREFIX)) {
    const wsId = workspaceDock.scope.slice(WORKSPACE_DOCK_SCOPE_PREFIX.length);
    if (!poppedOut.includes(wsId)) return wsId;
  }

  for (const ws of hosted) {
    const inst = getDockviewInstanceByScope(`${WORKSPACE_DOCK_SCOPE_PREFIX}${ws.id}`);
    const rect = inst?.getContainer?.()?.getBoundingClientRect();
    if (!rect || rect.width <= 8 || rect.height <= 8) continue;
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return ws.id;
    }
  }

  const hostHit = findModuleDropTargetWorkspace(clientX, clientY);
  if (hostHit && !poppedOut.includes(hostHit.workspaceId)) {
    return hostHit.workspaceId;
  }

  return null;
}

function isMainWindowWorkspaceDockVisible(): boolean {
  const bottom = useBottomPanelStore.getState();
  if (bottom.isFullscreen || bottom.workspaceMode === "fullscreen") return true;
  if (bottom.workspaceMode === "half" || bottom.embeddedMode === "half") return true;
  if (bottom.workspaceMode === "hidden" || bottom.embeddedMode === "hidden") return false;
  return bottom.workspaceMode === "taskbar" || bottom.embeddedMode === "taskbar";
}

/** 在目标窗 WebView 内根据落点解析工程工作区 id（主窗全屏工作区 / 独立工作区窗） */
function resolveIncomingWorkspaceTargetId(
  payload: CrossWindowDockDragCompletePayload,
  clientX: number,
  clientY: number,
): string | null {
  const workspaceDock = findEngineeringWorkspaceDockAt(clientX, clientY);
  if (workspaceDock?.scope.startsWith(WORKSPACE_DOCK_SCOPE_PREFIX)) {
    const wsId = workspaceDock.scope.slice(WORKSPACE_DOCK_SCOPE_PREFIX.length);
    if (!isWorkspacePoppedOut(wsId)) return wsId;
  }

  if (payload.targetWindowLabel === "main" && isMainWindowWorkspaceDockVisible()) {
    const hostedId = resolveMainWindowHostedWorkspaceId(clientX, clientY);
    if (hostedId) return hostedId;
  }

  const fromLabel = workspaceIdFromLabel(payload.targetWindowLabel);
  if (fromLabel && !isWorkspacePoppedOut(fromLabel)) return fromLabel;

  if (payload.targetWorkspaceId && !isWorkspacePoppedOut(payload.targetWorkspaceId)) {
    return payload.targetWorkspaceId;
  }

  return null;
}

function acquireDragCompletionLock(): void {
  dragCompletionLock = true;
  if (dragCompletionLockTimer) {
    clearTimeout(dragCompletionLockTimer);
  }
  dragCompletionLockTimer = setTimeout(() => {
    dragCompletionLock = false;
    dragCompletionLockTimer = null;
    crossDockLog("dragCompletionLock timeout released");
  }, DRAG_COMPLETION_LOCK_TIMEOUT_MS);
}

function releaseDragCompletionLock(): void {
  dragCompletionLock = false;
  if (dragCompletionLockTimer) {
    clearTimeout(dragCompletionLockTimer);
    dragCompletionLockTimer = null;
  }
}

function hasStaleOutboundSession(): boolean {
  if (localDrag || activeBroadcast) return true;
  if (remoteDrag && remoteDrag.expiresAt > Date.now()) return true;
  if (document.body.classList.contains("omnipanel-cross-window-dock-drag")) return true;
  const visual = useCrossWindowDragVisualStore.getState();
  if (visual.active && !pointerSeed && !isWorkspaceDockDragActive()) return true;
  return false;
}

function resetDragSession(options?: {
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
        document.body.classList.contains("omnipanel-cross-window-dock-drag") ||
        useCrossWindowDragVisualStore.getState().active,
    );
  if (!remoteDrag) {
    localDrag = null;
  }
  resetPointerSeed();
  clearRemoteDrag();
  clearLocalWorkspaceDockDragArtifacts();
  document.body.classList.remove("omnipanel-cross-window-dock-drag");
  releaseDragCompletionLock();
  clearWebviewWindowLabelCache();
  if (shouldBroadcast) {
    void options?.lite
      ? broadcastCrossWindowDragEndLite()
      : broadcastCrossWindowDragEnd();
  }
}

async function broadcastDragActive(
  session: CrossWindowDockDragPayload,
  screenX = 0,
  screenY = 0,
): Promise<void> {
  trackOutboundPanel(session.panelId);
  if (activeBroadcast) return;
  activeBroadcast = true;
  try {
    const current = getCurrentWebviewWindow().label;
    // 仅当指针已离开源窗几何时才计算命中目标。
    // 指针在源窗内时 targetLabel=null：源窗在顶层，不应有目标窗激活。
    const outside = isPointerOutsideCurrentWindow(screenX, screenY);
    const targetLabel = outside
      ? findOtherWindowHitSync(screenX, screenY, current)
      : null;
    await emitToOtherWebviews(
      CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT,
      {
        ...session,
        screenX,
        screenY,
        targetLabel,
      },
      current,
    );
    crossDockLog(`broadcast active from ${session.sourceWindowLabel} target=${targetLabel}`);
  } catch (e) {
    console.warn("[crossWindowDock] broadcast active failed", e);
    activeBroadcast = false;
  }
}

function broadcastDragMove(
  session: CrossWindowDockDragPayload,
  screenX: number,
  screenY: number,
): void {
  broadcastCrossWindowDragMove({
    sourceWindowLabel: session.sourceWindowLabel,
    label: session.tab.label?.trim() || session.panelId,
    screenX,
    screenY,
    kind: "workspace-tab",
  });
}

function maybeBroadcastActiveOnMove(
  session: CrossWindowDockDragPayload,
  screenX: number,
  screenY: number,
): void {
  void broadcastDragActive(session, screenX, screenY);
  broadcastDragMove(session, screenX, screenY);
}

function applyIncomingTab(
  targetWorkspaceId: string,
  tab: WorkspaceDockTab,
  backendSessionId?: string | null,
): boolean {
  if (isWorkspacePoppedOut(targetWorkspaceId)) {
    crossDockLog(`reject incoming tab: workspace popped out id=${targetWorkspaceId}`);
    return false;
  }
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
    requestDockScopeResync(scope);
  });
  return true;
}

function handleCompleteOnTarget(
  payload: CrossWindowDockDragCompletePayload,
  clientX: number,
  clientY: number,
  deferAttempt = 0,
): void {
  const targetWsId = resolveIncomingWorkspaceTargetId(payload, clientX, clientY);
  if (targetWsId) {
    const applied = applyIncomingTab(targetWsId, payload.tab, payload.backendSessionId);
    if (applied) {
      crossDockLog(`applied workspace tab to workspace ws=${targetWsId}`);
      emitSourceCleanup(payload, "workspace", { targetWorkspaceId: targetWsId });
    } else {
      crossDockLog(`apply to workspace failed ws=${targetWsId} panel=${payload.panelId}`);
    }
    return;
  }

  let moduleDock = findModuleDockAt(clientX, clientY);
  if (
    !moduleDock &&
    isTerminalWorkspaceTab(payload.tab) &&
    payload.targetWindowLabel === "main" &&
    deferAttempt === 0 &&
    isDropOverTerminalModuleArea(clientX, clientY)
  ) {
    window.dispatchEvent(
      new CustomEvent("omnipanel-navigate", {
        detail: { path: MODULE_PATHS.terminal },
      }),
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => handleCompleteOnTarget(payload, clientX, clientY, 1));
    });
    return;
  }

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
      emitSourceCleanup(payload, "module", { targetModuleScope: moduleDock.scope });
    } else {
      crossDockLog(
        `apply to module failed scope=${moduleDock.scope} panel=${payload.panelId}`,
      );
    }
    return;
  }

  crossDockLog(`no drop target at ${clientX},${clientY} panel=${payload.panelId}`);
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
    cancelDockviewPointerDrag();
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
  untrackOutboundPanel(resolvedId);
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
    (targetLabel === "main"
      ? null
      : resolveTargetWorkspaceIdForTransfer(targetLabel, session.sourceWorkspaceId));
  if (targetLabel !== "main" && !resolvedWorkspaceId) {
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
  crossWindowDockTransferCleanup?.();

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
    knownTargetLabel?: string | null,
  ): Promise<boolean> => {
    if (dragCompletionLock) return false;
    if (finishToken !== dragFinishToken) return false;
    acquireDragCompletionLock();
    try {
      const targetLabel =
        knownTargetLabel ??
        (isPointerOutsideCurrentWindow(screenX, screenY)
          ? await findWindowLabelAtScreenPoint(
              screenX,
              screenY,
              crossDockLog,
              currentLabel,
            )
          : currentLabel);
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
          dockWorkspaceId,
          screenX,
          screenY,
        );
        clearRemoteDrag();
        return true;
      }

      if (session && session.sourceWindowLabel === currentLabel && targetLabel !== currentLabel) {
        await completeCrossWindowTransfer(session, targetLabel, null, screenX, screenY);
        return true;
      }

      crossDockLog(
        `drop ignored current=${currentLabel} target=${targetLabel} hasSession=${Boolean(session)} hasRemote=${Boolean(remote)}`,
      );
      return false;
    } finally {
      releaseDragCompletionLock();
    }
  };

  const quietAbortDrag = (): void => {
    cancelDockviewPointerDrag();
    resetDragSession({ broadcastEnd: activeBroadcast });
  };

  const cleanupDragState = (
    session: CrossWindowDockDragPayload | null,
    transferCompleted: boolean,
  ): void => {
    cancelDockviewPointerDrag();
    scheduleOutboundDockRecovery(session, transferCompleted);
    resetDragSession({ broadcastEnd: true });
  };

  const onTabGrab = (event: Event) => {
    const detail = (event as CustomEvent<{
      panelId?: string;
      screenX?: number;
      screenY?: number;
    }>).detail;
    const panelId = detail?.panelId;
    if (!panelId) return;
    // 作废上一轮尚未完成的 pointerup 异步清理，避免连拖被误清
    dragFinishToken += 1;
    if (hasStaleOutboundSession()) {
      resetDragSession({ broadcastEnd: true });
    }
    // 预热窗口几何缓存，确保 pointerup 同步阶段的 findOtherWindowHitSync 有数据
    void primeWindowBoundsCache();
    seedPointerFromPanelId(panelId, detail.screenX ?? 0, detail.screenY ?? 0);
  };

  // dockview PointerDragController 未从主入口导出，子路径导入会得到另一个独立单例，
  // onDragStart/onDragMove/onDragEnd 订阅永远不会触发。
  // drag 检测改用 WORKSPACE_DOCK_TAB_GRAB_EVENT + document pointermove/pointerup
  // （上面已注册），ghost 收口改用 dockviewPointerDrag 派发的 pointercancel。

  const onPointerMove = (event: PointerEvent) => {
    if (!(event.buttons & 1)) return;
    // dockview 拖拽进行中也要继续广播 MOVE：出窗后 onDragMove 可能停更，
    // 目标窗 ghost 全靠这条 document 捕获路径续命
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
      isWorkspaceDockDragActive() ||
      isPointerOutsideCurrentWindow(event.screenX, event.screenY);

    if (!movedEnough) return;

    const session =
      localDrag ??
      (pointerSeed ? ensureLocalDrag(pointerSeed.panelId) : null);
    if (session) {
      maybeBroadcastActiveOnMove(session, event.screenX, event.screenY);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (isWindowChromePointerTarget(event.target)) {
      quietAbortDrag();
      return;
    }

    const currentLabel = getCurrentWebviewWindow().label;
    const remote =
      remoteDrag && remoteDrag.expiresAt > Date.now() ? remoteDrag : null;

    if (!remote && !pointerSeed && !localDrag && !isWorkspaceDockDragActive()) {
      return;
    }

    if (!remote && !dragMovedEnoughAt(event.screenX, event.screenY)) {
      quietAbortDrag();
      return;
    }

    const outside = isPointerOutsideCurrentWindow(event.screenX, event.screenY);
    // 重叠场景：指针仍在源窗几何内（outside=false），但可能有其他窗口覆盖在源窗之上。
    // 用 z-order 找最顶层命中窗口：如果最顶层是源窗，留在源窗；否则跨窗到覆盖窗口。
    let overlapHit: string | null = null;
    if (!outside && !remote) {
      const topmost = findTopmostWindowHitSync(event.screenX, event.screenY);
      overlapHit = topmost && topmost !== currentLabel ? topmost : null;
    }
    const isCrossWindow = remote || outside || overlapHit !== null;

    // 跨窗：必须在 await 之前同步抢走 dockview drop，否则 _handleEnd 会
    // moveGroupOrPanel 到已不存在的 group（Failed to find group id）
    if (isCrossWindow) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelDockviewPointerDrag();
    }

    if (!isCrossWindow) {
      // 同窗口内 drop：完全交给 dockview 自己处理（分屏等）。
      // 只清理本模块的指针种子/广播标志，**不**触碰 dockview DOM / store / pointercancel。
      // **不** untrackOutboundPanel：ensureLocalDrag 在 onPointerMove 中 track 了 panelId，
      // isWorkspaceDockOutboundTransfer 返回 true 会让 dockview onDidRemovePanel 跳过
      // onCloseTab（避免分屏移动 panel 时 store 中的 tab 被误删）。
      // untrackOutboundPanel 延迟到 dockview drop 完成后（microtask）执行。
      const panelIdToUntrack = pointerSeed?.panelId ?? localDrag?.panelId ?? null;
      const wasBroadcasting = activeBroadcast;
      resetPointerSeed();
      localDrag = null;
      clearRemoteDrag();
      releaseDragCompletionLock();
      queueMicrotask(() => {
        // dockview moveGroupOrPanel（bubble）在 microtask 之前同步完成，
        // 此时 untrack 安全：onDidRemovePanel 已走过 isWorkspaceDockOutboundTransfer 检查
        if (panelIdToUntrack) untrackOutboundPanel(panelIdToUntrack);
        if (wasBroadcasting) {
          void import("./crossWindowDragVisual").then(({ broadcastCrossWindowDragEndLite }) =>
            broadcastCrossWindowDragEndLite()
          );
        }
      });
      return;
    }

    const sessionAtUp = resolveDragSession();
    const finishToken = ++dragFinishToken;

    void (async (): Promise<boolean | "aborted"> => {
      let knownTarget: string | null = null;
      if (!remote) {
        knownTarget = await findWindowLabelAtScreenPoint(
          event.screenX,
          event.screenY,
          crossDockLog,
          currentLabel,
        );
        if (finishToken !== dragFinishToken) return "aborted";
        if (!knownTarget || knownTarget === currentLabel) {
          // 命中测试发现落点仍是本窗
          resetDragSession({ broadcastEnd: activeBroadcast });
          return "aborted";
        }
      }

      const session = sessionAtUp ?? resolveDragSession();
      if (!session && !remote) {
        crossDockLog("pointerup: no drag session");
        quietAbortDrag();
        return "aborted";
      }

      return finishDragAtScreenPoint(
        event.screenX,
        event.screenY,
        event.clientX,
        event.clientY,
        currentLabel,
        session,
        remote,
        finishToken,
        knownTarget,
      );
    })()
      .catch((e) => {
        console.warn("[crossWindowDock] pointerup failed", e);
        return false as boolean | "aborted";
      })
      .then((transferCompleted) => {
        // 异步命中测试期间若已开始新拖拽 / 已自行 abort，勿清掉新会话
        if (transferCompleted === "aborted") return;
        if (finishToken !== dragFinishToken) return;
        cleanupDragState(sessionAtUp, transferCompleted === true);
      });
  };

  window.addEventListener(WORKSPACE_DOCK_TAB_GRAB_EVENT, onTabGrab);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);

  void listen(CROSS_WINDOW_DRAG_END_EVENT, () => {
    forceEndDockviewPointerDrag();
    clearRemoteDrag();
    document.body.classList.remove("omnipanel-cross-window-dock-drag");
  }, { target: { kind: "Any" } }).then((fn) => unlisteners.push(fn));

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

      // 源窗跨窗松手时通常收不到 pointerup，必须在此强制拆掉原生 ghost
      forceEndDockviewPointerDrag();

      if (payload.targetWindowLabel === currentLabel) {
        const { clientX, clientY } = screenPointToClient(
          payload.dropScreenX,
          payload.dropScreenY,
        );
        handleCompleteOnTarget(payload, clientX, clientY);
      }

      document.body.classList.remove("omnipanel-cross-window-dock-drag");
      localDrag = null;
      resetPointerSeed();
      if (remoteDrag?.sourceWindowLabel === payload.sourceWindowLabel) {
        clearRemoteDrag();
      }
      void broadcastCrossWindowDragEnd();
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
      forceEndDockviewPointerDrag();
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

  const cleanup = () => {
    disposed = true;
    for (const d of dockDisposables) d.dispose();
    window.removeEventListener(WORKSPACE_DOCK_TAB_GRAB_EVENT, onTabGrab);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    for (const fn of unlisteners) safeTauriUnlisten(fn);
    resetDragSession({ broadcastEnd: false });
    recentTransferKeys.clear();
    pendingOutboundPanelIds.clear();
    dragFinishToken = 0;
    if (crossWindowDockTransferCleanup === cleanup) {
      crossWindowDockTransferCleanup = null;
    }
  };
  crossWindowDockTransferCleanup = cleanup;
  return cleanup;
}
