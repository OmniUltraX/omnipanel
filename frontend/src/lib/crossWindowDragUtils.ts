import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { cursorPosition } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { workspaceIdFromLabel } from "./workspaceWindow";

/** 优先用事件坐标换算物理像素，避免每次松手都打 cursorPosition IPC（可达 1s+） */
export async function resolvePhysicalScreenPoint(
  screenX?: number,
  screenY?: number,
): Promise<{ x: number; y: number }> {
  if (typeof screenX === "number" && typeof screenY === "number") {
    const dpr = window.devicePixelRatio || 1;
    return {
      x: screenX * dpr,
      y: screenY * dpr,
    };
  }
  try {
    const pos = await cursorPosition();
    return { x: pos.x, y: pos.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

export function resolveTargetWorkspaceId(windowLabel: string): string | null {
  if (windowLabel === "main") {
    return useWorkspaceStore.getState().workspace.id;
  }
  return workspaceIdFromLabel(windowLabel);
}

/** 跨窗落点对应的工作区 id（主窗落点用源工作区，避免弹出后主窗当前选中不一致） */
export function resolveTargetWorkspaceIdForTransfer(
  targetLabel: string,
  sourceWorkspaceId: string,
): string | null {
  if (targetLabel === "main") {
    return sourceWorkspaceId;
  }
  return workspaceIdFromLabel(targetLabel) ?? sourceWorkspaceId;
}

/** 屏幕坐标 → 当前 WebView 内 client 坐标（跨窗落点命中检测）。 */
export function screenPointToClient(
  screenX: number,
  screenY: number,
): { clientX: number; clientY: number } {
  return {
    clientX: screenX - window.screenX,
    clientY: screenY - window.screenY,
  };
}

function isScreenPointInCurrentWindow(screenX: number, screenY: number): boolean {
  return (
    screenX >= window.screenX &&
    screenX < window.screenX + window.outerWidth &&
    screenY >= window.screenY &&
    screenY < window.screenY + window.outerHeight
  );
}

/** 指针是否已离开当前 OS 窗口（零 IPC，用于跨窗拖出判定） */
export function isPointerOutsideCurrentWindow(screenX: number, screenY: number): boolean {
  const margin = 4;
  return (
    screenX < window.screenX + margin ||
    screenX > window.screenX + window.outerWidth - margin ||
    screenY < window.screenY + margin ||
    screenY > window.screenY + window.outerHeight - margin
  );
}

let cachedWebviewWindowLabels: string[] | null = null;
let cachedWebviewWindowsAt = 0;
const WEBVIEW_WINDOW_CACHE_MS = 5_000;

type WindowBounds = {
  label: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

let cachedWindowBounds: WindowBounds[] | null = null;
let cachedWindowBoundsAt = 0;
const WINDOW_BOUNDS_CACHE_MS = 1_000;

/**
 * 同步命中测试：用已缓存的窗口几何（物理像素）判断屏幕坐标（CSS 逻辑像素）
 * 是否落在某个非源窗内。
 *
 * 用于 onPointerUp 同步阶段：源窗与前景窗口几何重叠时，
 * `isPointerOutsideCurrentWindow` 会返回 false（指针仍在源窗几何内），
 * 导致跨窗路径被跳过、tab 错误落到源窗。
 * 此函数排除源窗后做几何命中，能在同步阶段就识别出重叠场景下的跨窗落点。
 *
 * 缓存为空（首次拖拽未填充）时返回 null，调用方应 fallback 到 outside 判断。
 */
export function findOtherWindowHitSync(
  screenX: number,
  screenY: number,
  currentLabel?: string,
): string | null {
  if (!cachedWindowBounds || cachedWindowBounds.length === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const x = screenX * dpr;
  const y = screenY * dpr;
  for (const b of cachedWindowBounds) {
    if (currentLabel && b.label === currentLabel) continue;
    if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
      return b.label;
    }
  }
  return null;
}

/**
 * 同步获取「唯一其他窗口」的 label。
 *
 * 当只有 1 个其他窗口时直接返回其 label，不做几何命中。
 * 用于 move 阶段的 sole-other 优化：指针已离开源窗（outside=true）时，
 * 几何命中可能因缓存 bounds 精度/坐标转换问题失败，但语义上指针只可能
 * 落在那个唯一的其他窗口上。与 `findWindowLabelAtScreenPoint` 的
 * sole-other 路径保持一致，让 move 阶段的 ghost 激活与 pointerup 的
 * drop 判定行为一致。
 */
export function getSoleOtherWindowLabelSync(currentLabel?: string): string | null {
  if (!cachedWindowBounds || cachedWindowBounds.length === 0) return null;
  const others = cachedWindowBounds.filter((b) => b.label !== currentLabel);
  return others.length === 1 ? others[0].label : null;
}

/**
 * 找 z-order 最顶层命中窗口（不排除源窗）。
 *
 * `cachedWindowBounds` 已按 z-order（顶→底）排序，
 * 返回第一个几何命中 = 视觉最顶层窗口。
 *
 * 用于 pointerup 落点判定：
 * - 源窗在顶层时 → 返回源窗 label → 留在源窗
 * - 其他窗口覆盖源窗时 → 返回该窗口 label → 跨窗转移
 */
export function findTopmostWindowHitSync(
  screenX: number,
  screenY: number,
): string | null {
  if (!cachedWindowBounds || cachedWindowBounds.length === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const x = screenX * dpr;
  const y = screenY * dpr;
  for (const b of cachedWindowBounds) {
    if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
      return b.label;
    }
  }
  return null;
}

/** 会话内缓存窗口 label 列表，避免拖拽中反复 getAllWebviewWindows */
export async function getCachedWebviewWindowLabels(
  excludeLabel?: string,
): Promise<string[]> {
  const now = Date.now();
  if (!cachedWebviewWindowLabels || now - cachedWebviewWindowsAt > WEBVIEW_WINDOW_CACHE_MS) {
    const wins = await getAllWebviewWindows();
    cachedWebviewWindowLabels = wins.map((w) => w.label);
    cachedWebviewWindowsAt = now;
  }
  if (!excludeLabel) return [...cachedWebviewWindowLabels];
  return cachedWebviewWindowLabels.filter((label) => label !== excludeLabel);
}

/**
 * 预热窗口几何缓存。在拖拽开始时（onTabGrab）await 调用，
 * 确保 pointerup 同步阶段的 `findOtherWindowHitSync` 有数据可读。
 */
export function primeWindowBoundsCache(): Promise<WindowBounds[]> {
  if (
    cachedWindowBounds &&
    Date.now() - cachedWindowBoundsAt <= WINDOW_BOUNDS_CACHE_MS
  ) {
    return Promise.resolve(cachedWindowBounds);
  }
  return getCachedWindowBounds();
}

/**
 * 向其他 WebView 定向广播（emitTo）。
 * 跨窗 ghost/ACTIVE/MOVE 必须用 emitTo：前端 emit() 在多 WebView 下经常到不了别的窗。
 */
export async function emitToOtherWebviews(
  event: string,
  payload: unknown,
  excludeLabel?: string,
): Promise<void> {
  const labels = await getCachedWebviewWindowLabels(excludeLabel);
  if (labels.length === 0) return;
  await Promise.all(labels.map((label) => emitTo(label, event, payload).catch(() => {})));
}

async function getCachedWindowBounds(): Promise<WindowBounds[]> {
  const now = Date.now();
  if (cachedWindowBounds && now - cachedWindowBoundsAt <= WINDOW_BOUNDS_CACHE_MS) {
    return cachedWindowBounds;
  }
  const wins = await getAllWebviewWindows();
  const bounds: WindowBounds[] = [];
  await Promise.all(
    wins.map(async (w) => {
      try {
        const [pos, size] = await Promise.all([w.outerPosition(), w.outerSize()]);
        bounds.push({
          label: w.label,
          left: pos.x,
          top: pos.y,
          right: pos.x + size.width,
          bottom: pos.y + size.height,
        });
      } catch {
        // ignore
      }
    }),
  );

  // 获取 Win32 z-order（顶→底），按 z-order 排序 bounds。
  // 多窗口重叠时 findOtherWindowHitSync 必须返回最顶层命中窗口，
  // 而非 HashMap 迭代顺序的第一个（可能是底层窗口）。
  try {
    const zOrder = await invoke<string[]>("window_z_order");
    if (zOrder.length > 0) {
      const orderIndex = new Map(zOrder.map((label, i) => [label, i]));
      bounds.sort((a, b) => {
        const ai = orderIndex.get(a.label) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderIndex.get(b.label) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    }
  } catch {
    // z-order 不可用时退回原始顺序（HashMap 顺序）
  }

  cachedWindowBounds = bounds;
  cachedWindowBoundsAt = now;
  cachedWebviewWindowLabels = bounds.map((b) => b.label);
  cachedWebviewWindowsAt = now;
  return bounds;
}

export function clearWebviewWindowLabelCache(): void {
  cachedWebviewWindowLabels = null;
  cachedWebviewWindowsAt = 0;
  cachedWindowBounds = null;
  cachedWindowBoundsAt = 0;
}

/** 窗口标题栏控件（最小化/最大化/关闭），跨窗 pointerup 时仅静默清理、不拦截 click */
export function isWindowChromePointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".win-controls, .win-btn"));
}

/**
 * 解析落点所在窗口 label。指针在本窗内时直接返回当前 label，避免跨窗拖放
 * pointerup 上每次都走 Tauri 命中测试（多窗口时可达 1–2s）。
 */
export async function resolveDropWindowLabel(
  screenX: number,
  screenY: number,
  currentLabel: string,
  log?: (message: string) => void,
): Promise<string | null> {
  if (isScreenPointInCurrentWindow(screenX, screenY)) {
    log?.(`hit current label=${currentLabel}`);
    return currentLabel;
  }
  return findWindowLabelAtScreenPoint(screenX, screenY, log, currentLabel);
}

/**
 * 跨窗落点命中。常见「主窗 ↔ 唯一工作区窗」场景：指针已出本窗且只剩一个其它窗时，
 * 直接返回该窗，零 IPC。
 *
 * `currentLabel` 会被排除：跨窗拖拽中源窗永远不可能是 drop 目标。
 * 当源窗与前景窗口几何重叠时，不排除源窗会让命中结果取决于 HashMap 迭代顺序，
 * 表现为「落到底层源窗」而非「落到顶层前景窗」。
 */
export async function findWindowLabelAtScreenPoint(
  screenX?: number,
  screenY?: number,
  log?: (message: string) => void,
  currentLabel?: string,
): Promise<string | null> {
  if (
    typeof screenX === "number" &&
    typeof screenY === "number" &&
    currentLabel &&
    isPointerOutsideCurrentWindow(screenX, screenY)
  ) {
    const others = await getCachedWebviewWindowLabels(currentLabel);
    if (others.length === 1) {
      log?.(`hit sole-other label=${others[0]} (skip IPC)`);
      return others[0];
    }
  }

  const { x, y } = await resolvePhysicalScreenPoint(screenX, screenY);

  // 先用缓存几何命中，避免同步 invoke 卡主线程
  try {
    const bounds = await getCachedWindowBounds();
    // bounds 已按 z-order（顶→底）排序，返回第一个命中 = 最顶层窗口
    for (const b of bounds) {
      // 排除源窗：跨窗拖拽中源窗永远不是 drop 目标。
      // 重叠场景下不排除会让源窗（底层）被错误命中。
      if (currentLabel && b.label === currentLabel) continue;
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
        log?.(`hit cached-bounds label=${b.label} @${x},${y}`);
        return b.label;
      }
    }
  } catch {
    // fall through
  }

  try {
    const label = await invoke<string | null>("window_label_at_screen_point", {
      x,
      y,
      excludeLabel: currentLabel ?? null,
    });
    if (label) {
      log?.(`hit invoke label=${label} @${x},${y}`);
      return label;
    }
  } catch (e) {
    log?.(`invoke hit-test failed: ${e}`);
  }

  log?.(`hit none @${x},${y}`);
  return null;
}
