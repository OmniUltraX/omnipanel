import { customPanelGridItemHeightPx } from "../../customPanelGrid";

/** Compose 监控小组件允许的最大栅格行数（7+ 容器时需超过默认 12） */
export const COMPOSE_MONITOR_MAX_GRID_H = 24;

/**
 * 小组件 chrome：header（padding 4+4 + 24 控件 + 底边 1）+ body 上下 --sp-2 + inner 上下边框。
 * 运行时优先用 {@link measureComposeMonitorChromePx} 实测。
 */
export const COMPOSE_MONITOR_CHROME_PX = 33 + 16 + 2;

/**
 * 量 header + body padding + inner border，不含 body 里多出来的空白。
 * 空白若算进 chrome，会把高度越撑越大。
 */
export function measureComposeMonitorChromePx(contentNode: HTMLElement): number {
  const body = contentNode.parentElement;
  if (!body) return COMPOSE_MONITOR_CHROME_PX;
  const inner = body.parentElement;
  const header = inner?.querySelector(".home-custom-panel-widget__header");
  const bodyStyle = getComputedStyle(body);
  const padding =
    (Number.parseFloat(bodyStyle.paddingTop) || 0) +
    (Number.parseFloat(bodyStyle.paddingBottom) || 0);
  const innerStyle = inner ? getComputedStyle(inner) : null;
  const border = innerStyle
    ? (Number.parseFloat(innerStyle.borderTopWidth) || 0) +
      (Number.parseFloat(innerStyle.borderBottomWidth) || 0)
    : 2;
  const headerH =
    header instanceof HTMLElement && header.offsetHeight > 0
      ? header.offsetHeight
      : 33;
  const chrome = headerH + padding + border;
  return chrome >= 40 ? chrome : COMPOSE_MONITOR_CHROME_PX;
}

/**
 * 量内容固有高度：只加总子节点，不含父级被旧栅格撑出的空白。
 * 根节点 scrollHeight 在 height:100% / 父级过高时会把空白算进去，两列收不回去。
 */
export function measureComposeContentPx(contentNode: HTMLElement): number {
  const children = [...contentNode.children] as HTMLElement[];
  if (children.length === 0) {
    return contentNode.scrollHeight;
  }
  const styles = getComputedStyle(contentNode);
  const gap =
    Number.parseFloat(styles.rowGap) || Number.parseFloat(styles.gap) || 0;
  let height = 0;
  for (let i = 0; i < children.length; i++) {
    height += children[i].offsetHeight;
    if (i > 0) height += gap;
  }
  return height;
}

/**
 * 将内容区实测高度（px）换算为 react-grid-layout 行数 h。
 * 取能盖住 content+chrome 的最小 h，避免按 rowHeight+margin 整除多出一行空白。
 * @param contentPx `.sc-docker-mon--compose` 内容固有高度
 */
export function gridHeightFromContentPx(
  contentPx: number,
  minBaseH = 2,
  maxH = COMPOSE_MONITOR_MAX_GRID_H,
  chromePx = COMPOSE_MONITOR_CHROME_PX,
): number {
  if (contentPx <= 0) {
    return minBaseH;
  }
  const need = contentPx + chromePx;
  let h = minBaseH;
  while (h < maxH && customPanelGridItemHeightPx(h) < need) {
    h += 1;
  }
  return h;
}

/** 空态 / 加载态回退高度 */
export function composeMonitorFallbackGridHeight(minBaseH = 2): number {
  return Math.max(2, minBaseH);
}

/**
 * RGL onLayoutChange 只回写位置。
 * w 由尺寸预设锁定，h 由内容测高写入；若把 RGL 的旧 h 写回，会与测高互相覆盖死循环。
 */
export function applyComposeRglPosition<
  T extends { x: number; y: number; w: number; h: number },
>(prev: T, item: { x: number; y: number }): T {
  if (prev.x === item.x && prev.y === item.y) return prev;
  return { ...prev, x: item.x, y: item.y };
}
