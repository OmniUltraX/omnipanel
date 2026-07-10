import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "./isTauriRuntime";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import {
  findEngineeringWorkspaceDockAt,
  findModuleDockAt,
} from "./dockviewRegistry";
import {
  screenPointToClient,
  clearWebviewWindowLabelCache,
  emitToOtherWebviews,
  isPointerOutsideCurrentWindow,
} from "./crossWindowDragUtils";

export const CROSS_WINDOW_DRAG_MOVE_EVENT = "omnipanel:cross-window-drag-move";
export const CROSS_WINDOW_DRAG_END_EVENT = "omnipanel:cross-window-drag-end";

const CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT = "omnipanel:cross-window-dock-drag-active";
const CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT = "omnipanel:cross-window-module-drag-active";

export type CrossWindowDragKind = "workspace-tab" | "module-tab";

export interface CrossWindowDragMovePayload {
  sourceWindowLabel: string;
  label: string;
  screenX: number;
  screenY: number;
  kind: CrossWindowDragKind;
}

export interface CrossWindowDropPreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
  kind: "workspace" | "module" | "split-left" | "split-right";
}

interface CrossWindowDragVisualState {
  active: boolean;
  label: string;
  screenX: number;
  screenY: number;
  kind: CrossWindowDragKind;
  isRemote: boolean;
  showGhost: boolean;
  dropPreview: CrossWindowDropPreviewRect | null;
  setRemoteSession: (payload: {
    label: string;
    kind: CrossWindowDragKind;
    sourceWindowLabel: string;
    screenX?: number;
    screenY?: number;
  }) => void;
  updatePointer: (screenX: number, screenY: number) => void;
  setDropPreview: (preview: CrossWindowDropPreviewRect | null) => void;
  setLocalOutbound: (payload: {
    label: string;
    kind: CrossWindowDragKind;
    screenX: number;
    screenY: number;
    showGhost: boolean;
  }) => void;
  clear: () => void;
}

const initialState = {
  active: false,
  label: "",
  screenX: 0,
  screenY: 0,
  kind: "workspace-tab" as CrossWindowDragKind,
  isRemote: false,
  showGhost: false,
  dropPreview: null as CrossWindowDropPreviewRect | null,
};

export const useCrossWindowDragVisualStore = create<CrossWindowDragVisualState>((set) => ({
  ...initialState,
  setRemoteSession: (payload) =>
    set({
      active: true,
      isRemote: true,
      showGhost: true,
      label: payload.label,
      kind: payload.kind,
      screenX: payload.screenX ?? 0,
      screenY: payload.screenY ?? 0,
      dropPreview: null,
    }),
  updatePointer: (screenX, screenY) => set({ screenX, screenY }),
  setDropPreview: (dropPreview) => set({ dropPreview }),
  setLocalOutbound: (payload) =>
    set({
      active: true,
      isRemote: false,
      showGhost: payload.showGhost,
      label: payload.label,
      kind: payload.kind,
      screenX: payload.screenX,
      screenY: payload.screenY,
    }),
  clear: () => set({ ...initialState }),
}));

/** 根据 client 坐标解析落点预览矩形（仿 dockview 分屏/整区高亮）。 */
export function resolveDropPreviewAt(
  clientX: number,
  clientY: number,
): CrossWindowDropPreviewRect | null {
  const workspaceDock = findEngineeringWorkspaceDockAt(clientX, clientY);
  if (workspaceDock) {
    const container = workspaceDock.getContainer?.();
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) return null;

    const tabBar = container.querySelector<HTMLElement>(".dv-tabs-and-actions-container");
    const tabBarRect = tabBar?.getBoundingClientRect();
    const contentTop = tabBarRect && tabBarRect.height > 0 ? tabBarRect.bottom : rect.top + 32;
    const contentHeight = Math.max(0, rect.bottom - contentTop);

    if (clientY >= contentTop && contentHeight > 24) {
      const midX = rect.left + rect.width / 2;
      if (clientX < midX) {
        return {
          left: rect.left,
          top: contentTop,
          width: rect.width / 2,
          height: contentHeight,
          kind: "split-left",
        };
      }
      return {
        left: midX,
        top: contentTop,
        width: rect.width / 2,
        height: contentHeight,
        kind: "split-right",
      };
    }

    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      kind: "workspace",
    };
  }

  const moduleDock = findModuleDockAt(clientX, clientY);
  if (moduleDock) {
    const container = moduleDock.getContainer?.();
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      kind: "module",
    };
  }

  return null;
}

function updateDropPreviewFromScreenPoint(screenX: number, screenY: number): void {
  const { clientX, clientY } = screenPointToClient(screenX, screenY);
  const preview = resolveDropPreviewAt(clientX, clientY);
  useCrossWindowDragVisualStore.getState().setDropPreview(preview);
}

const POINTER_UPDATE_THRESHOLD_PX = 4;
let dropPreviewRaf = 0;
let pendingPreviewPoint: { screenX: number; screenY: number } | null = null;
let lastPreviewScreenX = 0;
let lastPreviewScreenY = 0;
let lastPointerScreenX = 0;
let lastPointerScreenY = 0;

function shouldUpdatePointerPosition(screenX: number, screenY: number): boolean {
  if (
    Math.hypot(screenX - lastPointerScreenX, screenY - lastPointerScreenY) <
    POINTER_UPDATE_THRESHOLD_PX
  ) {
    return false;
  }
  lastPointerScreenX = screenX;
  lastPointerScreenY = screenY;
  return true;
}

function resetPointerThrottle(): void {
  lastPointerScreenX = 0;
  lastPointerScreenY = 0;
}

function scheduleDropPreviewFromScreenPoint(screenX: number, screenY: number): void {
  if (
    Math.hypot(screenX - lastPreviewScreenX, screenY - lastPreviewScreenY) <
    POINTER_UPDATE_THRESHOLD_PX
  ) {
    return;
  }
  pendingPreviewPoint = { screenX, screenY };
  if (dropPreviewRaf) return;
  dropPreviewRaf = requestAnimationFrame(() => {
    dropPreviewRaf = 0;
    const point = pendingPreviewPoint;
    pendingPreviewPoint = null;
    if (!point) return;
    lastPreviewScreenX = point.screenX;
    lastPreviewScreenY = point.screenY;
    updateDropPreviewFromScreenPoint(point.screenX, point.screenY);
  });
}

function clearDropPreviewSchedule(): void {
  if (dropPreviewRaf) {
    cancelAnimationFrame(dropPreviewRaf);
    dropPreviewRaf = 0;
  }
  pendingPreviewPoint = null;
  lastPreviewScreenX = 0;
  lastPreviewScreenY = 0;
  resetPointerThrottle();
}

function clearStaleDockviewDragArtifacts(): void {
  document
    .querySelectorAll(
      ".dv-tab-dragging, .dv-tab--dragging, .dv-resize-container-dragging",
    )
    .forEach((el) => {
      el.classList.remove(
        "dv-tab-dragging",
        "dv-tab--dragging",
        "dv-resize-container-dragging",
      );
    });
}

/**
 * 源窗本地更新 outbound ghost（指针已离开本窗时），零 IPC。
 * 出窗后 dockview 原生 ghost 会断，必须由本层接管，勿被 dv-tab-dragging class 挡住。
 */
export function updateLocalOutboundDragVisual(
  payload: CrossWindowDragMovePayload,
): void {
  if (!isTauriRuntime()) return;
  const current = getCurrentWebviewWindow().label;
  if (payload.sourceWindowLabel !== current) return;
  if (!isPointerOutsideCurrentWindow(payload.screenX, payload.screenY)) {
    const state = useCrossWindowDragVisualStore.getState();
    if (state.active && !state.isRemote) {
      useCrossWindowDragVisualStore.getState().clear();
    }
    return;
  }
  useCrossWindowDragVisualStore.getState().setLocalOutbound({
    label: payload.label,
    kind: payload.kind,
    screenX: payload.screenX,
    screenY: payload.screenY,
    showGhost: true,
  });
}

let pendingMovePayload: CrossWindowDragMovePayload | null = null;
let moveBroadcastRaf = 0;

/** 跨窗 MOVE：源窗本地 outbound + rAF 合并后 emitTo 各窗（目标窗 ghost / 落点高亮） */
export function broadcastCrossWindowDragMove(payload: CrossWindowDragMovePayload): void {
  updateLocalOutboundDragVisual(payload);
  if (!isTauriRuntime()) return;
  const current = getCurrentWebviewWindow().label;
  if (payload.sourceWindowLabel !== current) return;

  pendingMovePayload = payload;
  if (moveBroadcastRaf) return;
  moveBroadcastRaf = requestAnimationFrame(() => {
    moveBroadcastRaf = 0;
    const move = pendingMovePayload;
    pendingMovePayload = null;
    if (!move) return;
    // rAF 已限频；勿再用 4px 阈值挡掉首包跨窗 MOVE
    void emitToOtherWebviews(CROSS_WINDOW_DRAG_MOVE_EVENT, move, current);
  });
}

export async function broadcastCrossWindowDragEnd(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (moveBroadcastRaf) {
    cancelAnimationFrame(moveBroadcastRaf);
    moveBroadcastRaf = 0;
  }
  pendingMovePayload = null;
  clearDropPreviewSchedule();
  clearStaleDockviewDragArtifacts();
  clearWebviewWindowLabelCache();
  const current = getCurrentWebviewWindow().label;
  useCrossWindowDragVisualStore.getState().clear();
  // 本窗也要拆原生 ghost（源窗跨窗松手时常收不到 pointerup）
  const { forceEndDockviewPointerDrag } = await import("./dockviewPointerDrag");
  forceEndDockviewPointerDrag({ clearCrossWindowVisual: false });
  try {
    await emitToOtherWebviews(CROSS_WINDOW_DRAG_END_EVENT, {}, current);
  } catch {
    /* ignore */
  }
}

function tabLabelFromWorkspacePayload(tab: { label?: string } | undefined): string {
  return tab?.label?.trim() || "Tab";
}

let visualInitCleanup: (() => void) | null = null;

function registerTauriListener(
  unlisteners: UnlistenFn[],
  disposed: () => boolean,
  promise: Promise<UnlistenFn>,
): void {
  void promise.then((fn) => {
    if (disposed()) {
      safeTauriUnlisten(fn);
      return;
    }
    unlisteners.push(fn);
  });
}

/** 注册跨窗拖拽视觉层事件（主窗 + 工作区窗均需调用）。 */
export function initCrossWindowDragVisual(): () => void {
  if (!isTauriRuntime()) return () => {};
  visualInitCleanup?.();

  let disposed = false;
  const unlisteners: UnlistenFn[] = [];
  const isDisposed = () => disposed;
  const store = useCrossWindowDragVisualStore.getState;

  const onEnd = () => {
    clearDropPreviewSchedule();
    store().clear();
    void import("./dockviewPointerDrag").then(({ forceEndDockviewPointerDrag }) => {
      forceEndDockviewPointerDrag({ clearCrossWindowVisual: false });
    });
  };

  const onMove = (payload: CrossWindowDragMovePayload) => {
    const current = getCurrentWebviewWindow().label;
    if (payload.sourceWindowLabel === current) {
      return;
    }
    const state = useCrossWindowDragVisualStore.getState();
    if (!state.active) {
      store().setRemoteSession({
        label: payload.label,
        kind: payload.kind,
        sourceWindowLabel: payload.sourceWindowLabel,
        screenX: payload.screenX,
        screenY: payload.screenY,
      });
      scheduleDropPreviewFromScreenPoint(payload.screenX, payload.screenY);
      lastPointerScreenX = payload.screenX;
      lastPointerScreenY = payload.screenY;
      return;
    }
    if (!shouldUpdatePointerPosition(payload.screenX, payload.screenY)) return;
    store().updatePointer(payload.screenX, payload.screenY);
    scheduleDropPreviewFromScreenPoint(payload.screenX, payload.screenY);
  };

  /** 目标窗：本地 pointermove 补充跟手（源窗 MOVE 为主路径） */
  const onPointerMove = (event: PointerEvent) => {
    if (!(event.buttons & 1)) return;
    const state = useCrossWindowDragVisualStore.getState();
    if (!state.active || !state.isRemote) return;
    if (!shouldUpdatePointerPosition(event.screenX, event.screenY)) return;
    store().updatePointer(event.screenX, event.screenY);
    scheduleDropPreviewFromScreenPoint(event.screenX, event.screenY);
  };

  registerTauriListener(
    unlisteners,
    isDisposed,
    listen(CROSS_WINDOW_DRAG_MOVE_EVENT, (event) => {
      const payload = event.payload;
      if (!payload) return;
      onMove(payload);
    }, { target: { kind: "Any" } }),
  );

  registerTauriListener(
    unlisteners,
    isDisposed,
    listen(CROSS_WINDOW_DRAG_END_EVENT, () => onEnd(), { target: { kind: "Any" } }),
  );

  registerTauriListener(
    unlisteners,
    isDisposed,
    listen<{
      tab?: { label?: string };
      sourceWindowLabel?: string;
      screenX?: number;
      screenY?: number;
    }>(
      CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (payload.sourceWindowLabel === getCurrentWebviewWindow().label) return;
        store().setRemoteSession({
          label: tabLabelFromWorkspacePayload(payload.tab),
          kind: "workspace-tab",
          sourceWindowLabel: payload.sourceWindowLabel,
          screenX: payload.screenX,
          screenY: payload.screenY,
        });
        if (
          typeof payload.screenX === "number" &&
          typeof payload.screenY === "number" &&
          (payload.screenX !== 0 || payload.screenY !== 0)
        ) {
          scheduleDropPreviewFromScreenPoint(payload.screenX, payload.screenY);
        }
      },
      { target: { kind: "Any" } },
    ),
  );

  registerTauriListener(
    unlisteners,
    isDisposed,
    listen<{
      title?: string;
      sourceWindowLabel?: string;
      screenX?: number;
      screenY?: number;
    }>(
      CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (payload.sourceWindowLabel === getCurrentWebviewWindow().label) return;
        store().setRemoteSession({
          label: payload.title?.trim() || "Tab",
          kind: "module-tab",
          sourceWindowLabel: payload.sourceWindowLabel,
          screenX: payload.screenX,
          screenY: payload.screenY,
        });
        if (
          typeof payload.screenX === "number" &&
          typeof payload.screenY === "number" &&
          (payload.screenX !== 0 || payload.screenY !== 0)
        ) {
          scheduleDropPreviewFromScreenPoint(payload.screenX, payload.screenY);
        }
      },
      { target: { kind: "Any" } },
    ),
  );

  document.addEventListener("pointermove", onPointerMove, true);

  const cleanup = () => {
    disposed = true;
    for (const fn of unlisteners) safeTauriUnlisten(fn);
    unlisteners.length = 0;
    document.removeEventListener("pointermove", onPointerMove, true);
    store().clear();
    if (visualInitCleanup === cleanup) {
      visualInitCleanup = null;
    }
  };
  visualInitCleanup = cleanup;
  return cleanup;
}

export { tabLabelFromWorkspacePayload };
