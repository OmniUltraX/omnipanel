import { invoke } from "@tauri-apps/api/core";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  LogicalPosition,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/dpi";
import { isTauriRuntime } from "./isTauriRuntime";
import { useWorkspaceStore } from "../stores/workspaceStore";

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
  /** 所在显示器名称（多屏恢复优先） */
  monitorName?: string | null;
  /** 外框物理像素（虚拟桌面坐标） */
  physicalX?: number | null;
  physicalY?: number | null;
  physicalWidth?: number | null;
  physicalHeight?: number | null;
};

const SAVE_DEBOUNCE_MS = 400;
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const MIN_VISIBLE_PX = 80;
/** 无可用普通尺寸时的回退（逻辑像素） */
const DEFAULT_NORMAL_WIDTH = 1280;
const DEFAULT_NORMAL_HEIGHT = 800;

type TrackTarget =
  | { role: "main" }
  | { role: "workspace"; workspaceId: string };

/** 各窗口最近一次「非最大化」几何，供最大化落盘与 flush 共用 */
const lastNormalByKey = new Map<string, WindowBounds>();

function trackKey(target: TrackTarget): string {
  return target.role === "main" ? "main" : `ws:${target.workspaceId}`;
}

function isValidBounds(bounds: WindowBounds | null | undefined): bounds is WindowBounds {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= MIN_WIDTH &&
    height >= MIN_HEIGHT
  );
}

function asNormalBounds(bounds: WindowBounds): WindowBounds {
  return { ...bounds, maximized: false };
}

/** Win32 最小化后 outerPosition 常见哨兵坐标，不可落盘 */
const MINIMIZED_OFFSCREEN_THRESHOLD = -10_000;

/** 尺寸是否接近整屏（常见于误把最大化几何当普通尺寸写入） */
function looksLikeMonitorFill(bounds: WindowBounds, monitor: Monitor | null): boolean {
  if (!monitor) return false;
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const mw = monitor.size.width / scale;
  const mh = monitor.size.height / scale;
  return bounds.width >= mw - 48 && bounds.height >= mh - 48;
}

/** 最小化 / 屏外坐标：跳过持久化，避免副屏窗口被记到主屏 */
function looksLikeMinimizedOffscreen(bounds: WindowBounds): boolean {
  const px = bounds.physicalX ?? Math.round(bounds.x);
  const py = bounds.physicalY ?? Math.round(bounds.y);
  return px <= MINIMIZED_OFFSCREEN_THRESHOLD || py <= MINIMIZED_OFFSCREEN_THRESHOLD;
}

function monitorContainsPoint(mon: Monitor, px: number, py: number): boolean {
  const { x, y } = mon.position;
  const { width, height } = mon.size;
  return px >= x && py >= y && px < x + width && py < y + height;
}

function clampPhysicalToMonitor(
  px: number,
  py: number,
  pw: number,
  ph: number,
  mon: Monitor,
): { x: number; y: number; width: number; height: number } {
  const { x: mx, y: my } = mon.position;
  const { width: mw, height: mh } = mon.size;
  const maxX = Math.max(mx, mx + mw - MIN_VISIBLE_PX);
  const maxY = Math.max(my, my + mh - MIN_VISIBLE_PX);
  return {
    x: Math.min(Math.max(px, mx), maxX),
    y: Math.min(Math.max(py, my), maxY),
    width: Math.min(Math.max(pw, MIN_WIDTH), Math.max(mw, MIN_WIDTH)),
    height: Math.min(Math.max(ph, MIN_HEIGHT), Math.max(mh, MIN_HEIGHT)),
  };
}

function pickTargetMonitor(
  monitors: Monitor[],
  bounds: WindowBounds,
  px: number,
  py: number,
  primary: Monitor | null,
): Monitor | null {
  if (!monitors.length) return null;
  const byName = bounds.monitorName
    ? monitors.find((m) => m.name === bounds.monitorName)
    : undefined;
  if (byName) return byName;
  const byPoint = monitors.find((m) => monitorContainsPoint(m, px, py));
  if (byPoint) return byPoint;
  if (primary) {
    const match = monitors.find((m) => m.name === primary.name);
    if (match) return match;
  }
  return monitors[0] ?? null;
}

/** 按当前显示器布局解析几何：优先记忆屏，缺失则钳到可见区域。 */
async function resolveBoundsForCurrentDisplays(
  bounds: WindowBounds,
): Promise<WindowBounds> {
  const [monitors, primary] = await Promise.all([
    availableMonitors(),
    primaryMonitor(),
  ]);
  if (!monitors.length) return bounds;

  const scaleGuess = primary?.scaleFactor && primary.scaleFactor > 0 ? primary.scaleFactor : 1;
  let px = bounds.physicalX ?? Math.round(bounds.x * scaleGuess);
  let py = bounds.physicalY ?? Math.round(bounds.y * scaleGuess);
  let pw = bounds.physicalWidth ?? Math.round(bounds.width * scaleGuess);
  let ph = bounds.physicalHeight ?? Math.round(bounds.height * scaleGuess);
  pw = Math.max(pw, MIN_WIDTH);
  ph = Math.max(ph, MIN_HEIGHT);

  const target = pickTargetMonitor(monitors, bounds, px, py, primary);
  if (!target) return bounds;

  const onAny = monitors.some((m) => monitorContainsPoint(m, px, py));
  if (!onAny) {
    px = target.position.x + 40;
    py = target.position.y + 40;
  } else if (bounds.monitorName && target.name === bounds.monitorName) {
    const from = monitors.find((m) => monitorContainsPoint(m, px, py));
    if (from && from.name !== target.name) {
      px = target.position.x + (px - from.position.x);
      py = target.position.y + (py - from.position.y);
    }
  }

  const clamped = clampPhysicalToMonitor(px, py, pw, ph, target);
  const scale = target.scaleFactor > 0 ? target.scaleFactor : 1;
  return {
    x: clamped.x / scale,
    y: clamped.y / scale,
    width: clamped.width / scale,
    height: clamped.height / scale,
    maximized: bounds.maximized,
    monitorName: target.name,
    physicalX: clamped.x,
    physicalY: clamped.y,
    physicalWidth: clamped.width,
    physicalHeight: clamped.height,
  };
}

/** 读取当前窗口逻辑 + 物理几何，并记录所在显示器 */
export async function readCurrentWindowBounds(): Promise<WindowBounds | null> {
  if (!isTauriRuntime()) return null;
  try {
    const win = getCurrentWindow();
    if (await win.isMinimized()) return null;
    const [physicalPos, physicalSize, scale, maximized, monitor] = await Promise.all([
      win.outerPosition(),
      win.innerSize(),
      win.scaleFactor(),
      win.isMaximized(),
      currentMonitor(),
    ]);
    const factor = scale > 0 ? scale : 1;
    const bounds: WindowBounds = {
      x: physicalPos.x / factor,
      y: physicalPos.y / factor,
      width: physicalSize.width / factor,
      height: physicalSize.height / factor,
      maximized,
      monitorName: monitor?.name ?? null,
      physicalX: physicalPos.x,
      physicalY: physicalPos.y,
      physicalWidth: physicalSize.width,
      physicalHeight: physicalSize.height,
    };
    if (looksLikeMinimizedOffscreen(bounds)) return null;
    return bounds;
  } catch (e) {
    console.warn("[windowBounds] 读取失败", e);
    return null;
  }
}

/**
 * 构建可落盘几何：最大化时 width/height/physicalSize 必须是「取消最大化后」的普通尺寸，
 * 仅用当前位置/显示器标记最大化所在屏。
 */
function buildPersistableBounds(
  current: WindowBounds,
  lastNormal: WindowBounds | null,
): WindowBounds {
  if (!current.maximized) {
    return { ...current, maximized: false };
  }

  const base =
    lastNormal && isValidBounds(lastNormal) ? asNormalBounds(lastNormal) : null;

  if (!base) {
    return {
      x: current.x,
      y: current.y,
      width: DEFAULT_NORMAL_WIDTH,
      height: DEFAULT_NORMAL_HEIGHT,
      maximized: true,
      monitorName: current.monitorName ?? null,
      physicalX: current.physicalX ?? null,
      physicalY: current.physicalY ?? null,
      physicalWidth: null,
      physicalHeight: null,
    };
  }

  return {
    ...base,
    maximized: true,
    monitorName: current.monitorName ?? base.monitorName ?? null,
    // 记录最大化所在屏锚点；尺寸保持普通窗口，切勿写入当前最大化物理宽高
    physicalX: current.physicalX ?? base.physicalX ?? null,
    physicalY: current.physicalY ?? base.physicalY ?? null,
    physicalWidth: base.physicalWidth ?? null,
    physicalHeight: base.physicalHeight ?? null,
  };
}

async function persistMainBounds(bounds: WindowBounds): Promise<void> {
  await invoke("window_bounds_set_main", { bounds });
}

async function persistWorkspaceBounds(
  workspaceId: string,
  bounds: WindowBounds,
): Promise<void> {
  await invoke("window_bounds_set_workspace", { workspaceId, bounds });
  // 同步主窗 workspaceStore（独立窗 localStorage 不共享）
  try {
    useWorkspaceStore.getState().setWorkspaceBounds(workspaceId, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  } catch {
    /* child 窗 store 可能未水合，忽略 */
  }
}

export async function loadPersistedMainBounds(): Promise<WindowBounds | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<WindowBounds | null>("window_bounds_get_main");
  } catch {
    return null;
  }
}

export async function loadPersistedWorkspaceBounds(
  workspaceId: string,
): Promise<WindowBounds | null> {
  if (!isTauriRuntime() || !workspaceId) return null;
  try {
    return await invoke<WindowBounds | null>("window_bounds_get_workspace", {
      workspaceId,
    });
  } catch {
    return null;
  }
}

export async function applyWindowBounds(bounds: WindowBounds): Promise<void> {
  if (!isTauriRuntime() || !isValidBounds(bounds)) return;
  const win = getCurrentWindow();
  try {
    let placed = await resolveBoundsForCurrentDisplays(bounds);
    // 若历史数据把最大化尺寸误存为普通尺寸，恢复时用默认普通尺寸再 maximize
    if (placed.maximized) {
      const mon = await currentMonitor();
      if (looksLikeMonitorFill(placed, mon)) {
        const scale = mon && mon.scaleFactor > 0 ? mon.scaleFactor : 1;
        const px = placed.physicalX ?? Math.round(placed.x * scale);
        const py = placed.physicalY ?? Math.round(placed.y * scale);
        placed = {
          ...placed,
          width: DEFAULT_NORMAL_WIDTH,
          height: DEFAULT_NORMAL_HEIGHT,
          physicalWidth: Math.round(DEFAULT_NORMAL_WIDTH * scale),
          physicalHeight: Math.round(DEFAULT_NORMAL_HEIGHT * scale),
          physicalX: px,
          physicalY: py,
        };
      }
    }

    const setGeometry = async () => {
      if (
        placed.physicalX != null &&
        placed.physicalY != null &&
        Number.isFinite(placed.physicalX) &&
        Number.isFinite(placed.physicalY)
      ) {
        await win.setPosition(new PhysicalPosition(placed.physicalX, placed.physicalY));
      } else {
        await win.setPosition(new LogicalPosition(placed.x, placed.y));
      }
      if (
        placed.physicalWidth != null &&
        placed.physicalHeight != null &&
        Number.isFinite(placed.physicalWidth) &&
        Number.isFinite(placed.physicalHeight)
      ) {
        await win.setSize(new PhysicalSize(placed.physicalWidth, placed.physicalHeight));
      } else {
        await win.setSize(new LogicalSize(placed.width, placed.height));
      }
    };

    if (placed.maximized) {
      // 先落到上次普通尺寸再最大化，避免下次取消最大化时仍是整屏尺寸
      await win.unmaximize().catch(() => undefined);
      await setGeometry();
      await win.maximize();
      return;
    }
    await win.unmaximize().catch(() => undefined);
    await setGeometry();
  } catch (e) {
    console.warn("[windowBounds] 应用失败", e);
  }
}

/**
 * 手动恢复主窗几何（工作区窗等可复用）。
 * 主窗冷启动勿调用：Rust setup 在 visible:false 时已摆好再 show；
 * JS 再 restore 会二次改尺寸，loading 阶段可见跳动。
 */
export async function restoreMainWindowBounds(): Promise<void> {
  const bounds = await loadPersistedMainBounds();
  if (!isValidBounds(bounds)) return;
  await applyWindowBounds(bounds);
}

/**
 * 订阅移动/缩放并防抖落盘；返回清理函数。
 * 最大化时仍写入 maximized=true，但宽高使用上次非最大化尺寸。
 */
export function startWindowBoundsTracking(target: TrackTarget): () => void {
  if (!isTauriRuntime()) return () => undefined;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastNormalBounds: WindowBounds | null =
    lastNormalByKey.get(trackKey(target)) ?? null;
  let unlistenMoved: (() => void) | null = null;
  let unlistenResized: (() => void) | null = null;
  let disposed = false;

  const rememberNormal = (bounds: WindowBounds) => {
    lastNormalBounds = asNormalBounds(bounds);
    lastNormalByKey.set(trackKey(target), lastNormalBounds);
  };

  const persistNow = async () => {
    if (disposed) return;
    const current = await readCurrentWindowBounds();
    if (!current || !isValidBounds(current)) return;

    if (!current.maximized) {
      rememberNormal(current);
    }

    const toSave = buildPersistableBounds(current, lastNormalBounds);
    if (target.role === "main") {
      await persistMainBounds(toSave).catch(() => undefined);
    } else {
      await persistWorkspaceBounds(target.workspaceId, toSave).catch(() => undefined);
    }
  };

  const schedulePersist = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persistNow();
    }, SAVE_DEBOUNCE_MS);
  };

  const win = getCurrentWindow();
  let lastMonitorName: string | null | undefined = undefined;

  const rebindTaskbarIfMonitorChanged = async () => {
    try {
      if (await win.isMinimized()) return;
      const mon = await currentMonitor();
      const name = mon?.name ?? null;
      if (lastMonitorName === undefined) {
        lastMonitorName = name;
        return;
      }
      if (name && name !== lastMonitorName) {
        lastMonitorName = name;
        // Windows：跨屏拖拽后任务栏按钮常仍粘在旧屏，跳一下 skip 重新挂接
        await win.setSkipTaskbar(true);
        await win.setSkipTaskbar(false);
      } else if (name) {
        lastMonitorName = name;
      }
    } catch {
      /* ignore */
    }
  };

  void win.onMoved(() => {
    schedulePersist();
    void rebindTaskbarIfMonitorChanged();
  }).then((fn) => {
    if (disposed) fn();
    else unlistenMoved = fn;
  });
  void win.onResized(() => schedulePersist()).then((fn) => {
    if (disposed) fn();
    else unlistenResized = fn;
  });

  // 从磁盘种子 + 当前非最大化状态，确保启动即最大化时也有普通尺寸可记
  void (async () => {
    const persisted =
      target.role === "main"
        ? await loadPersistedMainBounds()
        : await loadPersistedWorkspaceBounds(target.workspaceId);
    if (disposed) return;
    if (persisted && isValidBounds(persisted)) {
      const mon = await currentMonitor().catch(() => null);
      if (!(persisted.maximized && looksLikeMonitorFill(persisted, mon))) {
        rememberNormal(persisted);
      }
    }
    const live = await readCurrentWindowBounds();
    if (disposed) return;
    if (live && isValidBounds(live) && !live.maximized) {
      rememberNormal(live);
    }
    if (lastMonitorName === undefined) {
      lastMonitorName = live?.monitorName ?? null;
    }
  })();

  const onPageHide = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void persistNow();
  };
  window.addEventListener("pagehide", onPageHide);

  return () => {
    disposed = true;
    window.removeEventListener("pagehide", onPageHide);
    if (timer) clearTimeout(timer);
    unlistenMoved?.();
    unlistenResized?.();
    void persistNow();
  };
}

/** 关闭前立即落盘（工作区窗 destroy 前 / 主窗关闭行为调用） */
export async function flushWindowBoundsNow(target: TrackTarget): Promise<void> {
  if (!isTauriRuntime()) return;
  const current = await readCurrentWindowBounds();
  if (!current || !isValidBounds(current)) return;
  if (!current.maximized) {
    lastNormalByKey.set(trackKey(target), asNormalBounds(current));
  }
  const lastNormal = lastNormalByKey.get(trackKey(target)) ?? null;
  const toSave = buildPersistableBounds(current, lastNormal);
  if (target.role === "main") {
    await persistMainBounds(toSave).catch(() => undefined);
  } else {
    await persistWorkspaceBounds(target.workspaceId, toSave).catch(() => undefined);
  }
}
