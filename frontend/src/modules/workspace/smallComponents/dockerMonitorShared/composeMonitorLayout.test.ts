import { describe, expect, it } from "vitest";
import {
  CUSTOM_PANEL_GRID_MARGIN,
  CUSTOM_PANEL_ROW_HEIGHT,
} from "../../customPanelGrid";
import {
  COMPOSE_MONITOR_CHROME_PX,
  COMPOSE_MONITOR_MAX_GRID_H,
  applyComposeRglPosition,
  gridHeightFromContentPx,
  measureComposeContentPx,
} from "./composeMonitorLayout";

/** 与 react-grid-layout calcGridItemWHPx(h, rowHeight, marginY) 一致 */
function rglItemHeightPx(h: number): number {
  return (
    h * CUSTOM_PANEL_ROW_HEIGHT +
    Math.max(0, h - 1) * CUSTOM_PANEL_GRID_MARGIN[1]
  );
}

describe("gridHeightFromContentPx", () => {
  it("picks the smallest h whose RGL pixel height covers content + chrome", () => {
    const contentPx = 1039;
    const need = contentPx + COMPOSE_MONITOR_CHROME_PX;
    const h = gridHeightFromContentPx(contentPx);

    expect(rglItemHeightPx(h)).toBeGreaterThanOrEqual(need);
    expect(rglItemHeightPx(h - 1)).toBeLessThan(need);
  });

  it("does not add a spare row from dividing by rowHeight+margin", () => {
    // 旧公式 ceil((content+56+12)/58) 在 12 容器量级会多算出 1 行
    expect(gridHeightFromContentPx(1039)).toBe(19);
    expect(rglItemHeightPx(19)).toBe(1092);
    expect(rglItemHeightPx(20)).toBe(1150);
  });

  it("caps at max grid rows", () => {
    expect(gridHeightFromContentPx(10_000)).toBe(COMPOSE_MONITOR_MAX_GRID_H);
  });

  it("falls back to minBaseH when content is empty", () => {
    expect(gridHeightFromContentPx(0, 3)).toBe(3);
  });
});

describe("measureComposeContentPx", () => {
  it("sums children and gap, ignoring a stretched parent scrollHeight", () => {
    const root = document.createElement("div");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.gap = "8px";
    const head = document.createElement("div");
    const list = document.createElement("div");
    root.append(head, list);
    document.body.append(root);
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(head, "offsetHeight", { configurable: true, value: 20 });
    Object.defineProperty(list, "offsetHeight", { configurable: true, value: 480 });
    expect(measureComposeContentPx(root)).toBe(508);
    root.remove();
  });
});

describe("applyComposeRglPosition", () => {
  it("keeps w/h so RGL cannot overwrite auto-height", () => {
    const prev = { x: 0, y: 0, w: 4, h: 10, minH: 2 };
    const next = applyComposeRglPosition(prev, { x: 2, y: 3 });
    expect(next).toEqual({ x: 2, y: 3, w: 4, h: 10, minH: 2 });
  });

  it("returns the same object when position is unchanged", () => {
    const prev = { x: 1, y: 2, w: 4, h: 10 };
    expect(applyComposeRglPosition(prev, { x: 1, y: 2 })).toBe(prev);
  });
});
