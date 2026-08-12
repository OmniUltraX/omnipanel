import type { SmallComponentSize } from "../types";

export const MYSQL_OVERVIEW_TYPE = "mysql-overview";

/**
 * 固定尺寸：4×3（高×宽，与服务器监控等预设命名一致）。
 * id = `${h}x${w}` → h:4, w:3
 */
export const MYSQL_OVERVIEW_SIZES: readonly SmallComponentSize[] = [
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

export const MYSQL_OVERVIEW_DB_TYPES = ["mysql", "mariadb"] as const;

export const MYSQL_OVERVIEW_REFRESH_MS = 30_000;

