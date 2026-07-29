import { describe, expect, it, afterEach } from "vitest";
import { defaultDataColumnWidth } from "./tableDataGridConstants";
import {
  estimateGridContentHeight,
  measureGridFillViewportWidth,
  measureScrollbarSize,
  resetScrollbarSizeCacheForTests,
} from "./tableDataGridViewport";

describe("defaultDataColumnWidth", () => {
  it("按类型给出差异化初始宽", () => {
    expect(defaultDataColumnWidth("boolean")).toBe(72);
    expect(defaultDataColumnWidth("int")).toBe(88);
    expect(defaultDataColumnWidth("bigint", null, "user_id")).toBe(110);
    expect(defaultDataColumnWidth("date")).toBe(118);
    expect(defaultDataColumnWidth("datetime")).toBe(150);
    expect(defaultDataColumnWidth("json")).toBe(160);
    expect(defaultDataColumnWidth("uuid")).toBe(280);
  });

  it("按声明长度分配文本列宽", () => {
    expect(defaultDataColumnWidth("varchar(8)", 8)).toBeLessThan(120);
    expect(defaultDataColumnWidth("varchar(32)", 32)).toBeGreaterThanOrEqual(120);
    expect(defaultDataColumnWidth("varchar(64)", 64)).toBe(200);
    expect(defaultDataColumnWidth("varchar(255)", 255)).toBe(260);
    expect(defaultDataColumnWidth("text")).toBe(280);
    expect(defaultDataColumnWidth("varchar(36)", 36)).toBe(200);
  });

  it("无类型时回退默认宽", () => {
    expect(defaultDataColumnWidth()).toBe(120);
    expect(defaultDataColumnWidth(null)).toBe(120);
  });
});

describe("measureGridFillViewportWidth", () => {
  afterEach(() => {
    resetScrollbarSizeCacheForTests();
  });

  it("无纵向溢出时使用 clientWidth 并减 slack", () => {
    const el = {
      clientWidth: 800,
      clientHeight: 400,
      offsetWidth: 800,
      scrollHeight: 300,
    } as HTMLElement;
    expect(measureGridFillViewportWidth(el)).toBe(790);
  });

  it("纵向溢出且滚动条尚未占位时预留 gutter", () => {
    resetScrollbarSizeCacheForTests();
    const sb = measureScrollbarSize();
    const el = {
      clientWidth: 800,
      clientHeight: 400,
      offsetWidth: 800,
      scrollHeight: 900,
    } as HTMLElement;
    if (sb === 0) {
      // overlay：仅减 slack
      expect(measureGridFillViewportWidth(el, { contentHeightHint: 900 })).toBe(790);
      return;
    }
    expect(measureGridFillViewportWidth(el)).toBe(800 - sb - 10);
  });

  it("gutter 已占位时不再二次扣除滚动条", () => {
    resetScrollbarSizeCacheForTests();
    const sb = Math.max(measureScrollbarSize(), 15);
    const el = {
      clientWidth: 785,
      clientHeight: 400,
      offsetWidth: 785 + sb,
      scrollHeight: 900,
    } as HTMLElement;
    if (measureScrollbarSize() === 0) {
      expect(measureGridFillViewportWidth(el)).toBe(775);
      return;
    }
    expect(measureGridFillViewportWidth(el)).toBe(775);
  });
});

describe("estimateGridContentHeight", () => {
  it("按行数估算高度", () => {
    expect(estimateGridContentHeight({ rowCount: 10, rowHeight: 32, headerHeight: 28 })).toBe(
      28 + 320,
    );
  });
});
