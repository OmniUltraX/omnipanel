import type { SmallComponentSize } from "../types";

export const REDIS_OVERVIEW_TYPE = "redis-overview";

/**
 * 固定尺寸：4×3（高×宽），与 MySQL 概览一致；支持 1×/2× 缩放。
 * id = `${h}x${w}` → h:4, w:3
 */
export const REDIS_OVERVIEW_SIZES: readonly SmallComponentSize[] = [
  {
    id: "4x3",
    w: 3,
    h: 4,
    minW: 3,
    minH: 4,
    maxW: 3,
    maxH: 4,
  },
];

export const REDIS_OVERVIEW_DB_TYPES = ["redis"] as const;

export const REDIS_OVERVIEW_REFRESH_MS = 30_000;
