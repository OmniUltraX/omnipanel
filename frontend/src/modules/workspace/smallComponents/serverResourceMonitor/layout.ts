import type { SmallComponentSize } from "../types";

/**
 * 内容布局（高×宽）：
 * - 3x3：主机概览卡（圆环 + 折线 + 明细行，同资源监控卡）
 * - 4x4：两行两列，圆环 + 折线
 * - 3x4：横向四个圆环
 * - 4x2：迷你进度条
 */
export type ServerMonitorLayoutMode = "3x3" | "4x4" | "3x4" | "4x2";

export const SERVER_RESOURCE_MONITOR_TYPE = "server-resource-monitor";

/** 预设：id = `${h}x${w}`；实例缩放边界取全部预设并集，勿用单项过严的 min/max */
export const SERVER_RESOURCE_MONITOR_SIZES: readonly SmallComponentSize[] = [
  {
    id: "6x3",
    w: 3,
    h: 6,
    minW: 1,
    minH: 1,
    maxW: 12,
    maxH: 12,
  },
  {
    id: "4x4",
    w: 4,
    h: 4,
    minW: 1,
    minH: 1,
    maxW: 12,
    maxH: 12,
  },
  {
    id: "3x4",
    w: 4,
    h: 3,
    minW: 1,
    minH: 1,
    maxW: 12,
    maxH: 12,
  },
  {
    id: "4x2",
    w: 2,
    h: 4,
    minW: 1,
    minH: 1,
    maxW: 12,
    maxH: 12,
  },
];

function isLayoutMode(id: string | undefined): id is ServerMonitorLayoutMode {
  return id === "3x3" || id === "4x4" || id === "3x4" || id === "4x2";
}

/** 旧预设 → 新预设（持久化迁移 / 内容模式兼容） */
export function migrateServerMonitorSizeId(
  sizeId: string | undefined,
  layout?: { w: number; h: number },
): ServerMonitorLayoutMode | undefined {
  // 历史：1x4 / 2x4 → 三高四宽圆环条；2x2 / 4x1 → 四高两宽进度条
  if (sizeId === "1x4" || sizeId === "2x4") return "3x4";
  if (sizeId === "2x2" || sizeId === "4x1") return "4x2";
  if (isLayoutMode(sizeId)) return sizeId;
  if (!layout) return undefined;
  const key = `${layout.h}x${layout.w}`;
  if (key === "1x4" || key === "2x4") return "3x4";
  if (key === "2x2" || key === "4x1") return "4x2";
  if (isLayoutMode(key)) return key;
  return undefined;
}

/**
 * 由 sizeId / 实际栅格推导内容模式。
 * 精确匹配 `${h}x${w}`；兼容旧预设；否则按形态归类。
 */
export function resolveServerMonitorLayoutMode(
  sizeId: string | undefined,
  layout: { w: number; h: number } | undefined,
): ServerMonitorLayoutMode {
  const migrated = migrateServerMonitorSizeId(sizeId, layout);
  if (migrated) return migrated;
  if (!layout) return "3x3";

  // 近正方形中等尺寸 → 3x3 概览卡
  if (layout.h === 3 && layout.w === 3) return "3x3";
  // 偏宽偏矮 → 3x4 圆环条
  if (layout.h <= 3 && layout.w >= 4) return "3x4";
  // 偏高偏窄 → 4x2 进度条
  if (layout.w <= 2 && layout.h >= 3) return "4x2";
  // 大块 → 4x4
  if (layout.h >= 4 && layout.w >= 4) return "4x4";
  return "3x3";
}

/** 按内容模式取预设栅格（迁移旧实例用） */
export function serverMonitorPresetByMode(
  mode: ServerMonitorLayoutMode,
): SmallComponentSize {
  const found = SERVER_RESOURCE_MONITOR_SIZES.find((s) => s.id === mode);
  return found ?? SERVER_RESOURCE_MONITOR_SIZES[0]!;
}
