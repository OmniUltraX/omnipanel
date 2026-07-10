import { create } from "zustand";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "./isTauriRuntime";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import {
  findEngineeringWorkspaceDockAt,
  findModuleDockAt,
} from "./dockviewRegistry";
import { screenPointToClient, findWindowLabelAtScreenPoint } from "./crossWindowDragUtils";

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
      screenX: 0,
      screenY: 0,
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

function isNativeDockDragActive(): boolean {
  return Boolean(
    document.querySelector(
      ".dv-tab-dragging, .dv-tab--dragging, .dv-resize-container-dragging",
    ),
  );
}

export function updateDropPreviewFromScreenPoint(screenX: number, screenY: number): void {
  const { clientX, clientY } = screenPointToClient(screenX, screenY);
  const preview = resolveDropPreviewAt(clientX, clientY);
  useCrossWindowDragVisualStore.getState().setDropPreview(preview);
}

/** 同窗拖动由 dockview 原生处理，不启用跨窗视觉层。 */
function shouldUseCrossWindowVisual(
  payload: CrossWindowDragMovePayload,
  currentLabel: string,
): boolean {
  if (payload.sourceWindowLabel !== currentLabel) {
    return true;
  }
  // 源窗：dockview 仍在拖时一律交给原生
  if (isNativeDockDragActive()) {
    return false;
  }
  return false;
}

async function shouldUseCrossWindowVisualAsync(
  payload: CrossWindowDragMovePayload,
  currentLabel: string,
): Promise<boolean> {
  if (payload.sourceWindowLabel !== currentLabel) {
    return true;
  }
  if (isNativeDockDragActive()) {
    return false;
  }
  const targetLabel = await findWindowLabelAtScreenPoint(payload.screenX, payload.screenY);
  return Boolean(targetLabel && targetLabel !== currentLabel);
}

export async function broadcastCrossWindowDragMove(
  payload: CrossWindowDragMovePayload,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const wins = await getAllWebviewWindows();
    await Promise.all(
      wins.map((w) => emitTo(w.label, CROSS_WINDOW_DRAG_MOVE_EVENT, payload).catch(() => {})),
    );
  } catch {
    /* ignore */
  }
}

export async function broadcastCrossWindowDragEnd(): Promise<void> {
  if (!isTauriRuntime()) return;
  useCrossWindowDragVisualStore.getState().clear();
  try {
    const wins = await getAllWebviewWindows();
    await Promise.all(
      wins.map((w) => emitTo(w.label, CROSS_WINDOW_DRAG_END_EVENT, {}).catch(() => {})),
    );
  } catch {
    /* ignore */
  }
}

function tabLabelFromWorkspacePayload(tab: { label?: string } | undefined): string {
  return tab?.label?.trim() || "Tab";
}

let visualInitCleanup: (() => void) | null = null;

/** 注册跨窗拖拽视觉层事件（主窗 + 工作区窗均需调用）。 */
export function initCrossWindowDragVisual(): () => void {
  if (!isTauriRuntime()) return () => {};
  visualInitCleanup?.();

  const unlisteners: UnlistenFn[] = [];
  const store = useCrossWindowDragVisualStore.getState;

  const onMove = (payload: CrossWindowDragMovePayload) => {
    const current = getCurrentWebviewWindow().label;

    if (!shouldUseCrossWindowVisual(payload, current)) {
      const state = useCrossWindowDragVisualStore.getState();
      if (state.active && !state.isRemote) {
        store().clear();
      }
      return;
    }

    if (payload.sourceWindowLabel === current) {
      void shouldUseCrossWindowVisualAsync(payload, current).then((useVisual) => {
        if (!useVisual) {
          const state = useCrossWindowDragVisualStore.getState();
          if (state.active && !state.isRemote) {
            store().clear();
          }
          return;
        }
        store().setLocalOutbound({
          label: payload.label,
          kind: payload.kind,
          screenX: payload.screenX,
          screenY: payload.screenY,
          showGhost: true,
        });
      });
      return;
    }

    if (!useCrossWindowDragVisualStore.getState().active) {
      store().setRemoteSession({
        label: payload.label,
        kind: payload.kind,
        sourceWindowLabel: payload.sourceWindowLabel,
      });
    }
    store().updatePointer(payload.screenX, payload.screenY);
    updateDropPreviewFromScreenPoint(payload.screenX, payload.screenY);
  };

  const onEnd = () => {
    store().clear();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!(event.buttons & 1)) return;
    const state = useCrossWindowDragVisualStore.getState();
    if (!state.active || !state.isRemote) return;
    store().updatePointer(event.screenX, event.screenY);
    updateDropPreviewFromScreenPoint(event.screenX, event.screenY);
  };

  void listen<CrossWindowDragMovePayload>(
    CROSS_WINDOW_DRAG_MOVE_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      onMove(payload);
    },
    { target: { kind: "Any" } },
  ).then((fn) => unlisteners.push(fn));

  void listen(CROSS_WINDOW_DRAG_END_EVENT, () => onEnd(), { target: { kind: "Any" } }).then(
    (fn) => unlisteners.push(fn),
  );

  void listen<{ tab?: { label?: string }; sourceWindowLabel?: string }>(
    CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      if (payload.sourceWindowLabel === getCurrentWebviewWindow().label) return;
      store().setRemoteSession({
        label: tabLabelFromWorkspacePayload(payload.tab),
        kind: "workspace-tab",
        sourceWindowLabel: payload.sourceWindowLabel,
      });
    },
    { target: { kind: "Any" } },
  ).then((fn) => unlisteners.push(fn));

  void listen<{ title?: string; sourceWindowLabel?: string }>(
    CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT,
    (event) => {
      const payload = event.payload;
      if (!payload) return;
      if (payload.sourceWindowLabel === getCurrentWebviewWindow().label) return;
      store().setRemoteSession({
        label: payload.title?.trim() || "Tab",
        kind: "module-tab",
        sourceWindowLabel: payload.sourceWindowLabel,
      });
    },
    { target: { kind: "Any" } },
  ).then((fn) => unlisteners.push(fn));

  document.addEventListener("pointermove", onPointerMove, true);

  const cleanup = () => {
    for (const fn of unlisteners) safeTauriUnlisten(fn);
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
