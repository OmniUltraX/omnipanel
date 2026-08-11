import type { SmallComponentSize } from "../types";

export const DOCKER_CONTAINER_MONITOR_TYPE = "docker-container-monitor";
export const DOCKER_COMPOSE_MONITOR_TYPE = "docker-compose-monitor";

/** 预制尺寸（高×宽）：紧凑卡 + 列表卡 */
export const DOCKER_MONITOR_SIZES: readonly SmallComponentSize[] = [
  {
    id: "3x3",
    w: 3,
    h: 3,
    minW: 2,
    minH: 2,
    maxW: 12,
    maxH: 12,
  },
  {
    id: "4x4",
    w: 4,
    h: 4,
    minW: 2,
    minH: 2,
    maxW: 12,
    maxH: 12,
  },
];
