import type {
  HomeCustomPanelWidget,
  SmallComponentDefinition,
  SmallComponentSize,
} from "./types";
import {
  SERVER_RESOURCE_MONITOR_TYPE,
  resolveServerMonitorLayoutMode,
} from "./serverResourceMonitor/layout";

/** 按 RGL 栅格尺寸匹配最近预设 id（高×宽） */
export function nearestSizeIdFromLayout(
  sizes: readonly SmallComponentSize[],
  layout: { w: number; h: number },
): string | undefined {
  if (sizes.length === 0) return undefined;
  let best: SmallComponentSize | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const preset of sizes) {
    const dist =
      Math.abs(preset.w - layout.w) + Math.abs(preset.h - layout.h) * 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = preset;
    }
  }
  return best?.id ?? `${layout.h}x${layout.w}`;
}

/**
 * 由实际栅格推导 sizeId（拖拽移动后对齐；尺寸切换以下拉预设为准）：
 * - 服务器监控：内容模式 id（仍为高×宽命名）
 * - 其它：最近预设或实际 `${h}x${w}`
 */
export function resolveWidgetSizeId(
  type: string,
  sizes: readonly SmallComponentSize[] | undefined,
  layout: { w: number; h: number },
  fallbackSizeId?: string,
): string | undefined {
  if (type === SERVER_RESOURCE_MONITOR_TYPE) {
    return resolveServerMonitorLayoutMode(fallbackSizeId, layout);
  }
  return (
    nearestSizeIdFromLayout(sizes ?? [], layout) ??
    fallbackSizeId ??
    `${layout.h}x${layout.w}`
  );
}

/**
 * 尺寸文案：当前 RGL 实际「高×宽」。
 * （尺寸切换已改用下拉预设；此函数保留给兼容调用）
 */
export function formatWidgetSizeLabel(
  widget: HomeCustomPanelWidget,
  _def?: SmallComponentDefinition,
  _t?: (key: never) => string,
): string {
  const { w, h } = widget.layout;
  return `${h}×${w}`;
}
