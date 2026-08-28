import type { SmallComponentSize } from "../types";

export const SPRING_BOOT_ADMIN_TYPE = "spring-boot-admin";

export const SPRING_BOOT_ADMIN_REFRESH_MS = 5_000;

export const SPRING_BOOT_ADMIN_HISTORY_MAX = 72;

/** 图表折线颜色（贴近 Spring Boot Admin：已用黄 / 已提交蓝 / 初始青绿） */
export const SBA_CHART_COLORS = {
  used: "#e6a23c",
  committed: "#409eff",
  init: "#2bb6a3",
  peak: "#9b8fd4",
} as const;

/**
 * 4×7 三列（与 SBA 性能页一致），6×4 纵向堆叠。
 * id = `${h}x${w}`
 */
export const SPRING_BOOT_ADMIN_SIZES: readonly SmallComponentSize[] = [
  {
    id: "4x7",
    w: 7,
    h: 4,
    minW: 4,
    minH: 3,
    maxW: 12,
    maxH: 12,
    labelKey: "homeWorkspace.widgets.springBootAdmin.sizeRow",
  },
  {
    id: "6x4",
    w: 4,
    h: 6,
    minW: 3,
    minH: 4,
    maxW: 12,
    maxH: 12,
    labelKey: "homeWorkspace.widgets.springBootAdmin.sizeCol",
  },
];

/** 旧 4×6 横向预设并入 4×7 */
export function migrateSpringBootAdminSizeId(
  sizeId: string | undefined,
): string | undefined {
  if (sizeId === "4x6") return "4x7";
  return sizeId;
}

export function springBootAdminChartLayout(
  sizeId: string | undefined,
): "row" | "col" {
  const id = migrateSpringBootAdminSizeId(sizeId);
  return id === "4x7" ? "row" : "col";
}
