/** Canvas 网格绘制倍率：设备像素对齐 + 可选超采样。 */

export const CANVAS_GRID_SUPERSAMPLE_STORAGE_KEY = "omnipanel.ui.canvasGridSupersample";
/** 相对 devicePixelRatio 的超采样倍数（默认开启）。 */
export const CANVAS_GRID_SUPERSAMPLE_FACTOR = 1.5;
/** 绘制倍率上限，避免 200%+ 系统缩放下缓冲爆炸。 */
export const CANVAS_GRID_SUPERSAMPLE_MAX = 3;

let cachedSupersample: boolean | null = null;

/** 默认开启 1.5× 超采样；localStorage 写 `"0"` / `"false"` 可关。 */
export function readStoredCanvasGridSupersample(): boolean {
  if (cachedSupersample != null) return cachedSupersample;
  try {
    const value = localStorage.getItem(CANVAS_GRID_SUPERSAMPLE_STORAGE_KEY);
    if (value === "0" || value === "false") {
      cachedSupersample = false;
      return false;
    }
    if (value === "1" || value === "true") {
      cachedSupersample = true;
      return true;
    }
  } catch {
    /* ignore */
  }
  cachedSupersample = true;
  return true;
}

export function writeStoredCanvasGridSupersample(enabled: boolean): void {
  cachedSupersample = enabled;
  try {
    localStorage.setItem(CANVAS_GRID_SUPERSAMPLE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function resolveDevicePixelRatio(
  devicePixelRatio: number = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.max(1, devicePixelRatio)
    : 1;
}

/**
 * 计算 Canvas 缓冲相对 CSS 像素的绘制倍率。
 * @param supersample 为 true 时在 DPR 上再乘 1.5（有上限）
 */
export function resolveCanvasPaintScale(
  supersample: boolean = true,
  devicePixelRatio?: number,
): number {
  const dpr = resolveDevicePixelRatio(devicePixelRatio);
  if (!supersample) return dpr;
  return Math.min(dpr * CANVAS_GRID_SUPERSAMPLE_FACTOR, CANVAS_GRID_SUPERSAMPLE_MAX);
}

/** 缓冲尺寸用 round，避免 floor 导致物理像素偏少、缩回 CSS 时发糊。 */
export function resolveCanvasBufferSize(
  cssWidth: number,
  cssHeight: number,
  paintScale: number,
): { width: number; height: number } {
  const scale = paintScale > 0 ? paintScale : 1;
  return {
    width: Math.max(1, Math.round(Math.max(0, cssWidth) * scale)),
    height: Math.max(1, Math.round(Math.max(0, cssHeight) * scale)),
  };
}

/** 将 CSS 坐标对齐到物理像素中心，减轻 fillText 落在半像素上发虚。 */
export function snapToDevicePixel(cssPx: number, paintScale: number): number {
  const scale = paintScale > 0 ? paintScale : 1;
  return Math.round(cssPx * scale) / scale;
}
