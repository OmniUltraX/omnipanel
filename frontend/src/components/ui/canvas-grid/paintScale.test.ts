import { describe, expect, it } from "vitest";

import {
  CANVAS_GRID_SUPERSAMPLE_FACTOR,
  CANVAS_GRID_SUPERSAMPLE_MAX,
  resolveCanvasBufferSize,
  resolveCanvasPaintScale,
  resolveDevicePixelRatio,
  snapToDevicePixel,
} from "./paintScale";

describe("resolveDevicePixelRatio", () => {
  it("clamps invalid values to 1", () => {
    expect(resolveDevicePixelRatio(0)).toBe(1);
    expect(resolveDevicePixelRatio(-2)).toBe(1);
    expect(resolveDevicePixelRatio(Number.NaN)).toBe(1);
  });

  it("keeps valid ratios", () => {
    expect(resolveDevicePixelRatio(1)).toBe(1);
    expect(resolveDevicePixelRatio(1.25)).toBe(1.25);
    expect(resolveDevicePixelRatio(2)).toBe(2);
  });
});

describe("resolveCanvasPaintScale", () => {
  it("returns raw dpr when supersample is off", () => {
    expect(resolveCanvasPaintScale(false, 1.25)).toBe(1.25);
    expect(resolveCanvasPaintScale(false, 2)).toBe(2);
  });

  it("applies 1.5× supersample with a hard cap", () => {
    expect(resolveCanvasPaintScale(true, 1)).toBe(1 * CANVAS_GRID_SUPERSAMPLE_FACTOR);
    expect(resolveCanvasPaintScale(true, 1.25)).toBeCloseTo(1.25 * CANVAS_GRID_SUPERSAMPLE_FACTOR);
    expect(resolveCanvasPaintScale(true, 2)).toBe(CANVAS_GRID_SUPERSAMPLE_MAX);
    expect(resolveCanvasPaintScale(true, 3)).toBe(CANVAS_GRID_SUPERSAMPLE_MAX);
  });
});

describe("resolveCanvasBufferSize", () => {
  it("rounds to whole buffer pixels", () => {
    expect(resolveCanvasBufferSize(100.4, 50.6, 1.5)).toEqual({
      width: Math.round(100.4 * 1.5),
      height: Math.round(50.6 * 1.5),
    });
  });

  it("never returns zero size", () => {
    expect(resolveCanvasBufferSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
  });
});

describe("snapToDevicePixel", () => {
  it("snaps css coords onto the paint-scale grid", () => {
    expect(snapToDevicePixel(10.2, 2)).toBe(10);
    expect(snapToDevicePixel(10.3, 2)).toBe(10.5);
    expect(snapToDevicePixel(12.34, 1.5)).toBe(Math.round(12.34 * 1.5) / 1.5);
  });
});
