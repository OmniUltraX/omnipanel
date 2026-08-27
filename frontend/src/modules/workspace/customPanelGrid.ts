/**
 * 自定义面板画布栅格（对齐 react-grid-layout showcase 的 12 列体系）
 * @see https://github.com/react-grid-layout/react-grid-layout/blob/master/test/examples/00-showcase.jsx
 */
export const CUSTOM_PANEL_GRID_COLS = 12;
export const CUSTOM_PANEL_ROW_HEIGHT = 48;
export const CUSTOM_PANEL_GRID_MARGIN: [number, number] = [10, 10];
export const CUSTOM_PANEL_GRID_PADDING: [number, number] = [10, 10];

/**
 * react-grid-layout 格子像素高：h × rowHeight + (h-1) × marginY。
 * @see calcGridItemWHPx(h, rowHeight, margin[1])
 */
export function customPanelGridItemHeightPx(h: number): number {
  if (h <= 0) return 0;
  return (
    h * CUSTOM_PANEL_ROW_HEIGHT +
    Math.max(0, h - 1) * CUSTOM_PANEL_GRID_MARGIN[1]
  );
}
