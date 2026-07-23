import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauriRuntime } from "./isTauriRuntime";
import { safeTauriUnlisten } from "./safeTauriUnlisten";
import { bindCrossWindowDragVisualStore } from "./dockviewPointerDrag";
import {
  findEngineeringWorkspaceDockAt,
  findModuleDockAt,
} from "./dockviewRegistry";
import {
  screenPointToClient,
  clearWebviewWindowLabelCache,
  emitToOtherWebviews,
  findOtherWindowHitSync,
  getSoleOtherWindowLabelSync,
  isPointerOutsideCurrentWindow,
} from "./crossWindowDragUtils";

export const CROSS_WINDOW_DRAG_MOVE_EVENT = "omnipanel:cross-window-drag-move";
export const CROSS_WINDOW_DRAG_END_EVENT = "omnipanel:cross-window-drag-end";

function visualLog(message: string): void {
  if (!import.meta.env.DEV) return;
  // 采样输出：pointermove 高频触发时每 200ms 最多打印一次，避免 DevTools 卡顿
  const now = Date.now();
  if (now - lastVisualLogAt < 200) return;
  lastVisualLogAt = now;
  console.info(`[crossWindowDragVisual] ${message}`);
}

let lastVisualLogAt = 0;

const CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT = "omnipanel:cross-window-dock-drag-active";
const CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT = "omnipanel:cross-window-module-drag-active";

export type CrossWindowDragKind = "workspace-tab" | "module-tab";

export interface CrossWindowDragMovePayload {
  sourceWindowLabel: string;
  label: string;
  screenX: number;
  screenY: number;
  kind: CrossWindowDragKind;
  /** 当前命中目标窗口 label（用于多窗口场景只激活命中窗的 ghost） */
  targetLabel?: string | null;
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
  setGhostVisible: (visible: boolean) => void;
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
      showGhost: false,
      label: payload.label,
      kind: payload.kind,
      screenX: payload.screenX ?? 0,
      screenY: payload.screenY ?? 0,
      dropPreview: null,
    }),
  updatePointer: (screenX, screenY) => set({ screenX, screenY }),
  setGhostVisible: (visible) => set({ showGhost: visible }),
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
 * 出窗后 dockview 原生 ghost 会断，必须由本层接管。
 *
 * 源窗收到 pointermove 说明源窗在顶层 → 恢复 dockview 原生 ghost。
 * 源窗不在顶层时收不到 pointermove，由 pointerout 隐藏 ghost。
 */

/** 检测是否为 dockview PointerGhost 元素 */
function isDockviewGhostElement(el: HTMLElement): boolean {
  const style = el.style;
  if (style.position !== "fixed") return false;
  if (style.pointerEvents !== "none") return false;
  const z = style.zIndex;
  if (z !== "99999" && z !== "9999") return false;
  return style.willChange === "transform";
}

/** 直接操作 DOM 隐藏/恢复 dockview 原生 ghost，不依赖 CSS selector 匹配 */
function setDockviewGhostHidden(hidden: boolean): void {
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isDockviewGhostElement(el)) continue;
    if (hidden) {
      el.style.display = "none";
    } else {
      el.style.removeProperty("display");
    }
  }
}

export function updateLocalOutboundDragVisual(
  payload: CrossWindowDragMovePayload,
  outside?: boolean,
  hitLabel?: string | null,
): void {
  if (!isTauriRuntime()) return;
  const current = getCurrentWebviewWindow().label;
  if (payload.sourceWindowLabel !== current) return;

  // 复用调用方已计算的几何结果，避免重复命中测试
  const isOutside = outside ?? isPointerOutsideCurrentWindow(payload.screenX, payload.screenY);

  if (!isOutside) {
    // 指针在源窗几何内：dockview 原生 ghost 由 pointerout/pointerover 控制。
    // 此处只清 outbound ghost（避免与目标窗 cross-window ghost 双重显示）。
    const state = useCrossWindowDragVisualStore.getState();
    if (state.active && !state.isRemote) {
      state.clear();
    }
    return;
  }

  // 指针已出源窗几何：隐藏 dockview 原生 ghost（pointerout 也会做同样的事）
  setDockviewGhostHidden(true);

  // 命中其他窗口 → 目标窗会显示 cross-window ghost，源窗不显示 outbound
  const resolvedHit = hitLabel ?? findOtherWindowHitSync(payload.screenX, payload.screenY, current);
  if (resolvedHit) {
    const state = useCrossWindowDragVisualStore.getState();
    if (state.active && !state.isRemote) {
      state.clear();
    }
    return;
  }

  // 未命中任何窗口（桌面空白处）→ 源窗显示 outbound ghost 跟手
  useCrossWindowDragVisualStore.getState().setLocalOutbound({
    label: payload.label,
    kind: payload.kind,
    screenX: payload.screenX,
    screenY: payload.screenY,
    showGhost: true,
  });
}

let pendingMovePayload: CrossWindowDragMovePayload | null = null;
let pendingMoveMeta: { outside: boolean; hitLabel: string | null } | null = null;
let moveBroadcastRaf = 0;

/** 跨窗 MOVE：源窗本地 outbound + rAF 合并后 emitTo 各窗（目标窗 ghost / 落点高亮） */
export function broadcastCrossWindowDragMove(payload: CrossWindowDragMovePayload): void {
  if (!isTauriRuntime()) return;
  const current = getCurrentWebviewWindow().label;
  if (payload.sourceWindowLabel !== current) return;

  // 几何计算只做一次，结果复用给 updateLocalOutboundDragVisual + payload
  const outside = isPointerOutsideCurrentWindow(payload.screenX, payload.screenY);
  let hitLabel: string | null = null;
  if (outside) {
    hitLabel = findOtherWindowHitSync(payload.screenX, payload.screenY, current);
    // sole-other 优化：几何命中失败时，如果只有 1 个其他窗口，直接用之。
    if (!hitLabel) {
      hitLabel = getSoleOtherWindowLabelSync(current);
    }
  }
  visualLog(
    `move from=${current} screen=(${payload.screenX},${payload.screenY}) outside=${outside} hitLabel=${hitLabel}`,
  );

  // 本地 outbound 视觉也合并到 rAF，避免每次 pointermove 同步触发 zustand setState → React 重渲染
  pendingMovePayload = { ...payload, targetLabel: hitLabel };
  pendingMoveMeta = { outside, hitLabel };
  if (moveBroadcastRaf) return;
  moveBroadcastRaf = requestAnimationFrame(() => {
    moveBroadcastRaf = 0;
    const move = pendingMovePayload;
    const meta = pendingMoveMeta;
    pendingMovePayload = null;
    pendingMoveMeta = null;
    if (!move) return;
    // 本地 outbound 视觉更新（复用几何结果，无重复计算）
    updateLocalOutboundDragVisual(move, meta?.outside, meta?.hitLabel);
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
  pendingMoveMeta = null;
  clearDropPreviewSchedule();
  clearStaleDockviewDragArtifacts();
  clearWebviewWindowLabelCache();
  setDockviewGhostHidden(false);
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

/**
 * 轻量级 END 广播：只清理跨窗视觉层 + 发送 END 事件给其他窗口，
 * **不**清理 dockview 原生拖拽 artifacts、**不** forceEndDockviewPointerDrag。
 *
 * 用于同窗口内 drop（非跨窗）：dockview 需要自己处理 pointerup 完成 drop，
 * 如果在 capture 阶段移除 dragging class / drop target overlay 或派发 pointercancel，
 * 会干扰 dockview 的原生 drop 处理（分屏失效）。
 */
export async function broadcastCrossWindowDragEndLite(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (moveBroadcastRaf) {
    cancelAnimationFrame(moveBroadcastRaf);
    moveBroadcastRaf = 0;
  }
  pendingMovePayload = null;
  pendingMoveMeta = null;
  clearDropPreviewSchedule();
  const current = getCurrentWebviewWindow().label;
  useCrossWindowDragVisualStore.getState().clear();
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

  // 注册同步 store 引用，让 dockviewPointerDrag 的安全兜底能同步检测跨窗视觉残留
  bindCrossWindowDragVisualStore(useCrossWindowDragVisualStore);

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

    const isHitTarget = payload.targetLabel === current;
    const state = useCrossWindowDragVisualStore.getState();

    visualLog(
      `onMove on=${current} source=${payload.sourceWindowLabel} targetLabel=${payload.targetLabel} isHitTarget=${isHitTarget} active=${state.active}`,
    );

    if (!isHitTarget) {
      // 非命中目标：清除全部视觉层（ghost + dropPreview + active）
      // 多窗口场景核心：只有命中窗才显示任何效果
      if (state.active) {
        visualLog(`onMove clear (non-hit) on=${current}`);
        store().clear();
      }
      return;
    }

    // 命中目标：激活（如未激活）+ 更新位置 + ghost + dropPreview
    if (!state.active) {
      visualLog(`onMove activate ghost on=${current} label=${payload.label}`);
      store().setRemoteSession({
        label: payload.label,
        kind: payload.kind,
        sourceWindowLabel: payload.sourceWindowLabel,
        screenX: payload.screenX,
        screenY: payload.screenY,
      });
      lastPointerScreenX = payload.screenX;
      lastPointerScreenY = payload.screenY;
    } else if (shouldUpdatePointerPosition(payload.screenX, payload.screenY)) {
      store().updatePointer(payload.screenX, payload.screenY);
    }
    scheduleDropPreviewFromScreenPoint(payload.screenX, payload.screenY);
    store().setGhostVisible(true);
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

  /**
   * 源窗：指针离开本窗 document（移到另一个 OS 窗口或重叠区域被前景窗口覆盖）。
   * pointerout + relatedTarget===null 是 OS 级信号，比几何命中更可靠。
   * 源窗不在顶层时收不到 pointermove，dockview ghost 停在最后位置，
   * 由 pointerout 隐藏，pointerover 恢复。
   */
  let pointerOverRaf = 0;
  let pointerOutRaf = 0;

  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget !== null) return;
    // 早退：跨窗拖拽未激活时直接返回，不查 DOM。
    // 最大化/还原动画期间元素位移会触发数百次 pointerout，
    // 每次 querySelector 累积开销巨大。
    if (!useCrossWindowDragVisualStore.getState().active) return;
    cancelAnimationFrame(pointerOutRaf);
    pointerOutRaf = requestAnimationFrame(() => {
      setDockviewGhostHidden(true);
    });
  };

  const onPointerOver = () => {
    // 早退：同上。store.active 标识跨窗拖拽是否激活（remote/local session 设置后置 true）。
    if (!useCrossWindowDragVisualStore.getState().active) return;
    // rAF 节流：动画期间高频 pointerover 每帧最多执行一次恢复
    cancelAnimationFrame(pointerOverRaf);
    pointerOverRaf = requestAnimationFrame(() => {
      setDockviewGhostHidden(false);
    });
  };

  registerTauriListener(
    unlisteners,
    isDisposed,
    listen<CrossWindowDragMovePayload>(CROSS_WINDOW_DRAG_MOVE_EVENT, (event) => {
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
      targetLabel?: string | null;
    }>(
      CROSS_WINDOW_DOCK_DRAG_ACTIVE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        const current = getCurrentWebviewWindow().label;
        if (payload.sourceWindowLabel === current) return;
        // 非命中目标：不激活视觉层（后续 MOVE 会持续纠正）
        if (payload.targetLabel !== current) return;
        store().setRemoteSession({
          label: tabLabelFromWorkspacePayload(payload.tab),
          kind: "workspace-tab",
          sourceWindowLabel: payload.sourceWindowLabel ?? "",
          screenX: payload.screenX,
          screenY: payload.screenY,
        });
        store().setGhostVisible(true);
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
      targetLabel?: string | null;
    }>(
      CROSS_WINDOW_MODULE_DRAG_ACTIVE_EVENT,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        const current = getCurrentWebviewWindow().label;
        if (payload.sourceWindowLabel === current) return;
        // 非命中目标：不激活视觉层（后续 MOVE 会持续纠正）
        if (payload.targetLabel !== current) return;
        store().setRemoteSession({
          label: payload.title?.trim() || "Tab",
          kind: "module-tab",
          sourceWindowLabel: payload.sourceWindowLabel ?? "",
          screenX: payload.screenX,
          screenY: payload.screenY,
        });
        store().setGhostVisible(true);
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
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("pointerover", onPointerOver, true);

  const cleanup = () => {
    disposed = true;
    cancelAnimationFrame(pointerOverRaf);
    cancelAnimationFrame(pointerOutRaf);
    for (const fn of unlisteners) safeTauriUnlisten(fn);
    unlisteners.length = 0;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("pointerover", onPointerOver, true);
    setDockviewGhostHidden(false);
    store().clear();
    bindCrossWindowDragVisualStore(null);
    if (visualInitCleanup === cleanup) {
      visualInitCleanup = null;
    }
  };
  visualInitCleanup = cleanup;
  return cleanup;
}

export { tabLabelFromWorkspacePayload };
