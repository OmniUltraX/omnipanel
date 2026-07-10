/**
 * dockview PointerDragController 单例桥接 + 原生 ghost 强制收口。
 *
 * 跨窗松手时源窗往往收不到 pointerup，PointerGhost 会一直挂在源窗 body。
 * drop 抛错时 `_handleEnd` 也不会走到 `_teardown()`。
 */

type DockviewPointerDragController = {
  cancel: () => void;
  readonly active?: unknown;
  _handleEnd?: (e: PointerEvent, dropped: boolean) => void;
};

let controller: DockviewPointerDragController | null = null;
let handleEndPatched = false;
let safetyInstalled = false;
let safetyCleanup: (() => void) | null = null;

export function bindDockviewPointerDragController(
  instance: DockviewPointerDragController | null,
): void {
  controller = instance;
  if (instance) {
    patchHandleEndOnce(instance);
  }
}

/** 同步取消原生 pointer 拖拽并清掉残留 ghost DOM */
export function cancelDockviewPointerDrag(): void {
  try {
    controller?.cancel();
  } catch {
    /* dockview 内部状态异常时忽略 */
  }
  clearDockviewNativeDragArtifacts();
}

/**
 * 跨窗完成 / END / 源窗清理时调用：源窗可能从未收到 pointerup。
 */
export function forceEndDockviewPointerDrag(options?: {
  clearCrossWindowVisual?: boolean;
}): void {
  cancelDockviewPointerDrag();
  if (options?.clearCrossWindowVisual === false) return;
  void import("./crossWindowDragVisual")
    .then(({ useCrossWindowDragVisualStore }) => {
      const state = useCrossWindowDragVisualStore.getState();
      if (state.active) state.clear();
    })
    .catch(() => {});
}

/**
 * 松手 / 回窗 / Esc 兜底。在 useCrossWindowDragInit 中安装一次即可。
 */
export function installDockviewPointerDragSafety(): () => void {
  if (safetyInstalled) {
    return () => {
      safetyCleanup?.();
    };
  }
  safetyInstalled = true;

  const forceEndIfStuck = () => {
    const stillActive = Boolean(controller?.active);
    const hasOrphanGhost = hasOrphanedPointerGhost();
    const hasDraggingClass = Boolean(
      document.querySelector(
        ".dv-tab-dragging, .dv-tab--dragging, .dv-resize-container-dragging",
      ),
    );
    if (!stillActive && !hasOrphanGhost && !hasDraggingClass) return;
    forceEndDockviewPointerDrag();
  };

  const onPointerUp = () => {
    queueMicrotask(forceEndIfStuck);
    requestAnimationFrame(forceEndIfStuck);
  };

  /** 鼠标回到源窗且已松键：清掉跨窗松手后残留的原生 ghost */
  const onPointerMove = (event: PointerEvent) => {
    if (event.buttons & 1) return;
    if (!controller?.active && !hasOrphanedPointerGhost()) return;
    forceEndIfStuck();
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

  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", forceEndIfStuck);
  window.addEventListener("blur", forceEndIfStuck);
  document.addEventListener("keydown", onKeyDown, true);

  safetyCleanup = () => {
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", forceEndIfStuck);
    window.removeEventListener("blur", forceEndIfStuck);
    document.removeEventListener("keydown", onKeyDown, true);
    safetyInstalled = false;
    safetyCleanup = null;
  };

  return safetyCleanup;
}

function patchHandleEndOnce(instance: DockviewPointerDragController): void {
  if (handleEndPatched) return;
  const proto = Object.getPrototypeOf(instance) as DockviewPointerDragController;
  const original = proto._handleEnd;
  if (typeof original !== "function") return;
  handleEndPatched = true;

  proto._handleEnd = function patchedHandleEnd(
    this: DockviewPointerDragController,
    e: PointerEvent,
    dropped: boolean,
  ) {
    try {
      original.call(this, e, dropped);
    } catch (err) {
      try {
        this.cancel();
      } catch {
        /* ignore */
      }
      clearDockviewNativeDragArtifacts();
      console.warn(
        "[dockviewPointerDrag] native drop failed; forced ghost teardown",
        err,
      );
    } finally {
      // 双保险：即便 cancel 异常，也扫掉 body 上的 PointerGhost
      clearDockviewNativeDragArtifacts();
    }
  };
}

/** 清理 dockview 原生 PointerGhost DOM + dragging class */
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
}

function hasOrphanedPointerGhost(): boolean {
  for (const el of Array.from(document.body.children)) {
    if (el instanceof HTMLElement && isOrphanedPointerGhostElement(el)) {
      return true;
    }
  }
  return false;
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
