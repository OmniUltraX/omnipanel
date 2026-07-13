/**
 * dockview 原生 PointerDragController 收口：通过派发 pointercancel 让 dockview 自己 teardown。
 *
 * 跨窗松手时源窗往往收不到 pointerup，dockview 的 _active / _ghost / _upListener 残留，
 * 表现为源窗 ghost 元素挂 body 上不消失，鼠标回窗时闪烁。
 *
 * 根治方案：
 * - pointerdown 捕获 pointerId。
 * - 跨窗完成 / forceEnd 时向源窗 window 派发原生 pointercancel 事件，
 *   dockview 的 _cancelListener 检测到 e.pointerId === _active.pointerId 后
 *   走 _handleEnd(e, false) → handleDragLeave + _teardown()，
 *   真正销毁 _ghost（dispose）、清空 _active、dispose 所有 listener。
 * - patch moveGroupOrPanel 加 try/catch：跨窗后源窗 group 已移除会抛
 *   "Failed to find group id"，吞错让 _handleEnd 走 _teardown。
 * - clearDockviewNativeDragArtifacts 兜底清 drop target overlay 残留。
 *
 * 不再需要：
 * - 子路径 import PointerDragController（dockview 未导出，子路径是另一个独立单例）
 * - CSS 隐藏 .dv-tab-ghost-drag
 * - MutationObserver 监听 ghost 重建
 */
import { DockviewComponent } from "dockview-core";

type MoveGroupOrPanelFn = (options: unknown) => void;
let moveGroupOrPanelPatched = false;

let safetyInstalled = false;
let safetyCleanup: (() => void) | null = null;

/**
 * 跨窗视觉 store 引用（由 crossWindowDragVisual 模块注册）。
 * 用同步引用而非动态 import，以便 forceEndIfStuck 同步检测残留视觉层。
 */
type VisualStoreRef = {
  getState: () => { active: boolean; clear: () => void };
};
let useCrossWindowDragVisualStoreRef: VisualStoreRef | null = null;

export function bindCrossWindowDragVisualStore(store: VisualStoreRef | null): void {
  useCrossWindowDragVisualStoreRef = store;
}

/**
 * Patch DockviewComponent.prototype.moveGroupOrPanel。
 *
 * 必须从主入口 `dockview-core` 导入 DockviewComponent 才能拿到 dockview 内部
 * 实际使用的那个 prototype（子路径导入是另一个独立模块）。
 * 模块加载时立即 patch，所有 DockviewComponent 实例都生效。
 *
 * 跨窗拖拽成功后源窗的 panel 已被移除，源窗收到 pointerup/pointercancel 时
 * moveGroupOrPanel 会 throw "Failed to find group id"。
 * try/catch 吞掉错误，让 _handleEnd 继续走 _teardown()，
 * 自然释放 _active / _ghost / _upListener。
 */
function patchMoveGroupOrPanelOnce(): void {
  if (moveGroupOrPanelPatched) return;
  const proto = DockviewComponent.prototype as unknown as {
    moveGroupOrPanel?: MoveGroupOrPanelFn;
  };
  const original = proto.moveGroupOrPanel;
  if (typeof original !== "function") return;
  moveGroupOrPanelPatched = true;

  proto.moveGroupOrPanel = function patchedMoveGroupOrPanel(
    this: unknown,
    options: unknown,
  ) {
    try {
      original.call(this, options);
    } catch (err) {
      // 跨窗拖拽后源窗 group 已移除，moveGroupOrPanel 会 throw。
      // 吞掉错误避免 _handleEnd 中断，让 _teardown 正常执行。
      console.warn("[dockviewPointerDrag] moveGroupOrPanel threw", err);
    }
  };
}
patchMoveGroupOrPanelOnce();

/**
 * 最近一次 pointerdown 的 pointerId。
 * dockview 的 PointerDragController.beginDrag 用 pointerEvent.pointerId 存入 _active，
 * 派发 pointercancel 时必须带相同 id 才能命中 _cancelListener 的
 * `e.pointerId !== this._active.pointerId` 守卫。
 *
 * 鼠标拖拽 pointerId 恒为 1，但触摸/笔会有不同值，统一从 pointerdown 捕获。
 * 没有正在进行 dockview 拖拽时派发也是无害的：_active 为 undefined，
 * _cancelListener 直接 return。
 */
let lastPointerId: number | null = null;

/**
 * 向当前 window 派发原生 pointercancel 事件。
 *
 * dockview 的 _cancelListener（bubble phase，注册在 source.ownerDocument.defaultView 上）
 * 收到事件后检查 e.pointerId === _active.pointerId，匹配则走
 * _handleEnd(e, false) → handleDragLeave + _teardown()。
 *
 * 不用 pointerup：会触发 handleDrop 导致 panel 误移到 (0,0)。
 * 不用 pointercancel 全局拦截：只在显式 forceEnd/cancel 时派发。
 */
function dispatchPointerCancelToDockview(): boolean {
  const pointerId = lastPointerId;
  if (pointerId == null) return false;
  try {
    const event = new PointerEvent("pointercancel", {
      pointerId,
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理 dockview 原生 PointerGhost DOM + dragging class + 残留 drop target overlay。
 *
 * 兜底：dockview _teardown 正常执行后 _ghost.dispose() 已经移除 ghost 元素，
 * 但 _handleEnd 抛错时 drop target overlay 可能残留（表现为源窗 dock 效果无法取消）。
 */
export function clearDockviewNativeDragArtifacts(): void {
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isOrphanedPointerGhostElement(el)) continue;
    el.remove();
  }

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

  // _handleEnd 抛错时 dockview 的 drop target overlay 可能未被 _removeOverlay 清掉：
  // .dv-drop-target class 残留在 group 容器上，.dv-dropzone / .dv-drop-target-anchor
  // 仍挂在 DOM 里，表现为源窗"dock 窗口效果"无法取消。
  document.querySelectorAll(".dv-drop-target").forEach((el) => {
    el.classList.remove("dv-drop-target");
  });
  document
    .querySelectorAll(".dv-dropzone, .dv-drop-target-anchor")
    .forEach((el) => {
      el.remove();
    });
}

/**
 * 同步取消 dockview 原生 pointer 拖拽：派发 pointercancel + 兜底清理 DOM。
 * 不清跨窗视觉层，用于 drag 中途本地 abort。
 */
export function cancelDockviewPointerDrag(): void {
  dispatchPointerCancelToDockview();
  clearDockviewNativeDragArtifacts();
}

/**
 * 跨窗完成 / END / 源窗清理时调用。
 *
 * 1. 向 window 派发 pointercancel，让 dockview _cancelListener 走 _teardown：
 *    - _ghost.dispose() 真正销毁 ghost 元素（不是 CSS 隐藏）
 *    - _active = undefined
 *    - _upListener / _moveListener / _cancelListener 全部 dispose
 * 2. 兜底清理残留 drop target overlay。
 * 3. 清理跨窗视觉层。
 */
export function forceEndDockviewPointerDrag(options?: {
  clearCrossWindowVisual?: boolean;
}): void {
  dispatchPointerCancelToDockview();
  clearDockviewNativeDragArtifacts();
  if (options?.clearCrossWindowVisual === false) return;
  // 优先用同步引用清视觉层，避免动态 import 延迟导致 ghost 残留
  const store = useCrossWindowDragVisualStoreRef;
  if (store) {
    try {
      const state = store.getState();
      if (state.active) state.clear();
    } catch {
      /* ignore */
    }
    return;
  }
  void import("./crossWindowDragVisual")
    .then(({ useCrossWindowDragVisualStore }) => {
      const state = useCrossWindowDragVisualStore.getState();
      if (state.active) state.clear();
    })
    .catch(() => {});
}

/**
 * 松手 / 回窗 / Esc 兜底。在 useCrossWindowDragInit 中安装一次即可。
 *
 * safety 网不再做主动 ghost 检测/隐藏，只在有 dragging class / drop target overlay
 * 残留时触发一次 forceEndDockviewPointerDrag。dockview _teardown 正常执行后
 * 这些检查都是 no-op。
 */
export function installDockviewPointerDragSafety(): () => void {
  if (safetyInstalled) {
    return () => {
      safetyCleanup?.();
    };
  }
  safetyInstalled = true;

  const onPointerDownCapture = (event: PointerEvent) => {
    lastPointerId = event.pointerId;
  };

  const forceEndIfStuck = () => {
    const hasDraggingClass = Boolean(
      document.querySelector(
        ".dv-tab-dragging, .dv-tab--dragging, .dv-resize-container-dragging",
      ),
    );
    const hasDropTargetOverlay = Boolean(
      document.querySelector(".dv-drop-target, .dv-dropzone"),
    );
    let crossWindowVisualActive = false;
    try {
      crossWindowVisualActive = !!useCrossWindowDragVisualStoreRef?.getState?.()?.active;
    } catch {
      /* store 未初始化时忽略 */
    }
    if (
      !hasDraggingClass &&
      !hasDropTargetOverlay &&
      !crossWindowVisualActive
    ) {
      return;
    }
    // 只做 DOM 清理（和旧代码行为一致），**不**派发 pointercancel。
    // 旧代码的 controller.cancel() 是 NO-OP（子路径单例错误），
    // 实际只做了 clearDockviewNativeDragArtifacts。
    // 新代码如果在这里派发真实 pointercancel，会在 onPointerMove(buttons===0)
    // 边界情况时提前 dispose dockview _upListener，导致 pointerup 不触发 handleDrop（分屏失效）。
    // pointercancel 只在显式跨窗取消时派发：cancelDockviewPointerDrag / forceEndDockviewPointerDrag。
    clearDockviewNativeDragArtifacts();
    const store = useCrossWindowDragVisualStoreRef;
    if (store) {
      try {
        const state = store.getState();
        if (state.active) state.clear();
      } catch {
        /* ignore */
      }
    }
  };

  const onPointerUp = () => {
    queueMicrotask(forceEndIfStuck);
    requestAnimationFrame(forceEndIfStuck);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.buttons & 1) return; // 仍按住，跳过
    // 拖拽中可能出现 buttons===0 的 pointermove（Windows 鼠标捕获边界情况），
    // 此时不应触发清理，否则会干扰正在进行的 dockview 拖拽。
    // 真正的 stuck drag 由 pointerup 的 microtask/rAF 兜底处理。
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      forceEndIfStuck();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      forceEndDockviewPointerDrag();
    }
  };

  document.addEventListener("pointerdown", onPointerDownCapture, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", onKeyDown, true);

  safetyCleanup = () => {
    document.removeEventListener("pointerdown", onPointerDownCapture, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("keydown", onKeyDown, true);
    safetyInstalled = false;
    safetyCleanup = null;
  };

  return safetyCleanup;
}

/**
 * PointerGhost：body 直挂，inline style 为
 * position:fixed; left/top:0; z-index:99999; pointer-events:none; will-change:transform
 */
function isOrphanedPointerGhostElement(el: HTMLElement): boolean {
  if (el.classList.contains("cross-window-drag-visual-root")) return false;
  if (el.classList.contains("cross-window-drag-ghost")) return false;

  const style = el.style;
  if (style.position !== "fixed") return false;
  if (style.pointerEvents !== "none") return false;

  const z = style.zIndex;
  if (z !== "99999" && z !== "9999") return false;

  // 最稳：PointerGhost 构造时写死的组合
  if (style.willChange === "transform") return true;

  return (
    el.classList.contains("dv-tab") ||
    el.classList.contains("dv-default-tab") ||
    el.classList.contains("dv-tabs-container") ||
    Boolean(el.querySelector(".dv-tab, .dv-default-tab, .dv-default-tab-content"))
  );
}
