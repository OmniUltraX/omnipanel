import {
  CUSTOM_PANEL_GRID_MARGIN,
  CUSTOM_PANEL_ROW_HEIGHT,
} from "../../customPanelGrid";

/** Compose 监控小组件允许的最大栅格行数（7+ 容器时需超过默认 12） */
export const COMPOSE_MONITOR_MAX_GRID_H = 24;

/** 小组件 chrome 头 + body 上下内边距（像素） */
export const COMPOSE_MONITOR_CHROME_PX = 56;

/**
 * 将内容区实测高度（px）换算为 react-grid-layout 行数 h。
 * @param contentPx `.sc-docker-mon--compose` 根节点 scrollHeight
 */
export function gridHeightFromContentPx(
  contentPx: number,
  minBaseH = 2,
  maxH = COMPOSE_MONITOR_MAX_GRID_H,
): number {
  if (contentPx <= 0) {
    return minBaseH;
  }
  const rowUnitPx = CUSTOM_PANEL_ROW_HEIGHT + CUSTOM_PANEL_GRID_MARGIN[1];
  // 额外 buffer：边框、gap 取整误差
  const totalPx = contentPx + COMPOSE_MONITOR_CHROME_PX + 12;
  const h = Math.max(minBaseH, Math.ceil(totalPx / rowUnitPx));
  return Math.min(maxH, h);
}

/** 空态 / 加载态回退高度 */
export function composeMonitorFallbackGridHeight(minBaseH = 3): number {
  return Math.max(2, minBaseH);
}
