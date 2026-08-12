import { CUSTOM_PANEL_GRID_COLS } from "../customPanelGrid";
import type { SmallComponentSize } from "./types";

/** 全体小组件支持的等比缩放倍率 */
export const WIDGET_SCALE_FACTORS = [1, 2] as const;
export type WidgetScale = (typeof WIDGET_SCALE_FACTORS)[number];

export const DEFAULT_WIDGET_SCALE: WidgetScale = 1;

export function normalizeWidgetScale(raw: unknown): WidgetScale {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (n === 2) return 2;
  return 1;
}

/** 将预设宽高按倍率缩放，宽度不超过画布列数 */
export function applyWidgetScale(
  base: Pick<SmallComponentSize, "w" | "h">,
  scale: WidgetScale,
): { w: number; h: number } {
  const factor = normalizeWidgetScale(scale);
  return {
    w: Math.max(1, Math.min(CUSTOM_PANEL_GRID_COLS, Math.round(base.w * factor))),
    h: Math.max(1, Math.round(base.h * factor)),
  };
}

/**
 * 由定义预设推导拖拽边界，并计入最大缩放倍率（默认 2×）。
 */
export function sizeBoundsWithScale(
  sizes: readonly SmallComponentSize[],
  maxScale: WidgetScale = 2,
): Pick<SmallComponentSize, "minW" | "minH" | "maxW" | "maxH"> {
  if (sizes.length === 0) return {};
  let minW = Infinity;
  let minH = Infinity;
  let maxW = -Infinity;
  let maxH = -Infinity;
  for (const s of sizes) {
    minW = Math.min(minW, s.minW ?? s.w);
    minH = Math.min(minH, s.minH ?? s.h);
    const baseMaxW = s.maxW ?? s.w;
    const baseMaxH = s.maxH ?? s.h;
    maxW = Math.max(maxW, baseMaxW, s.w * maxScale);
    maxH = Math.max(maxH, baseMaxH, s.h * maxScale);
  }
  return {
    minW,
    minH,
    maxW: Math.min(CUSTOM_PANEL_GRID_COLS, maxW),
    maxH,
  };
}

/** 从 sizeId 解析预设；找不到则回退第一项 */
export function resolveBaseSizePreset(
  sizes: readonly SmallComponentSize[],
  sizeId: string | undefined,
): SmallComponentSize | undefined {
  if (!sizes.length) return undefined;
  if (sizeId) {
    const found = sizes.find(
      (s) => (s.id ?? `${s.h}x${s.w}`) === sizeId,
    );
    if (found) return found;
  }
  return sizes[0];
}

/**
 * 若未持久化 scale，尝试用 layout 相对 base 推断（接近 2× 则视为 2）。
 */
export function inferWidgetScale(
  base: Pick<SmallComponentSize, "w" | "h"> | undefined,
  layout: { w: number; h: number } | undefined,
  rawScale?: unknown,
): WidgetScale {
  if (rawScale === 1 || rawScale === 2) return rawScale;
  if (typeof rawScale === "string" && (rawScale === "1" || rawScale === "2")) {
    return Number(rawScale) as WidgetScale;
  }
  if (!base || !layout) return DEFAULT_WIDGET_SCALE;
  if (base.w <= 0 || base.h <= 0) return DEFAULT_WIDGET_SCALE;
  const rw = layout.w / base.w;
  const rh = layout.h / base.h;
  if (rw >= 1.75 && rh >= 1.75) return 2;
  return 1;
}
