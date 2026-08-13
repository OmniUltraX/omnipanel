import type { SmallComponentSize } from "../types";

export const BT_JAVA_WEBSITE_MONITOR_TYPE = "bt-java-website-monitor";

export const BT_JAVA_WEBSITE_MONITOR_REFRESH_MS = 4000;

/**
 * 固定尺寸：4×3（高×宽），与 MySQL / Redis 概览一致。
 * id = `${h}x${w}` → h:4, w:3
 */
export const BT_JAVA_WEBSITE_MONITOR_SIZES: readonly SmallComponentSize[] = [
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
