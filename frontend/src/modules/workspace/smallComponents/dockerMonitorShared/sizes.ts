import type { SmallComponentSize } from "../types";

export const DOCKER_CONTAINER_MONITOR_TYPE = "docker-container-monitor";
export const DOCKER_COMPOSE_MONITOR_TYPE = "docker-compose-monitor";

/** 单容器监控预制尺寸 */
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

/** Compose 监控：行高随容器数量自动扩展，上限 24 行 */
export const DOCKER_COMPOSE_MONITOR_SIZES: readonly SmallComponentSize[] = [
  {
    id: "3x3",
    w: 3,
    h: 3,
    minW: 2,
    minH: 2,
    maxW: 12,
    maxH: 24,
  },
  {
    id: "4x4",
    w: 4,
    h: 4,
    minW: 2,
    minH: 2,
    maxW: 12,
    maxH: 24,
  },
];
