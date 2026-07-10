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
    let hit: string | null = null;
    for (const b of bounds) {
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
        hit = b.label;
      }
    }
    if (hit) {
      log?.(`hit cached-bounds label=${hit} @${x},${y}`);
      return hit;
    }
  } catch {
    // fall through
  }

  try {
    const label = await invoke<string | null>("window_label_at_screen_point", { x, y });
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
