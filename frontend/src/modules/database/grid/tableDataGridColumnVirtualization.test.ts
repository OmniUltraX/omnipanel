import { describe, expect, it } from "vitest";
import type { Column } from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  buildColumnVirtualizationLayout,
  COLUMN_VIRTUALIZE_THRESHOLD,
  shouldVirtualizeGridColumns,
} from "./tableDataGridColumnVirtualization";

function fakeColumns(count: number): Column<Record<string, unknown>, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? "__row_num__" : `col_${index}`,
  })) as Column<Record<string, unknown>, unknown>[];
}

describe("buildColumnVirtualizationLayout", () => {
  it("列数超过阈值但未提供 virtualItems 时回退为全列渲染", () => {
    const leafColumns = fakeColumns(COLUMN_VIRTUALIZE_THRESHOLD + 5);
    expect(shouldVirtualizeGridColumns(leafColumns.length)).toBe(true);

    const layout = buildColumnVirtualizationLayout(leafColumns, false, [], [], 0);

    expect(layout.enabled).toBe(false);
    expect(layout.virtualIndices).toEqual(leafColumns.map((_, index) => index));
    expect(layout.visibleCellCount).toBe(leafColumns.length);
  });

  it("提供 virtualItems 时按虚拟窗口裁剪", () => {
    const leafColumns = fakeColumns(COLUMN_VIRTUALIZE_THRESHOLD + 5);
    const virtualizableIndices = leafColumns
      .map((_, index) => index)
      .filter((index) => index > 0);
    const virtualItems = [
      { index: 0, start: 40, end: 100, size: 60, key: 0 },
      { index: 1, start: 100, end: 160, size: 60, key: 1 },
    ] as VirtualItem[];

    const layout = buildColumnVirtualizationLayout(
      leafColumns,
      false,
      virtualItems,
      virtualizableIndices,
      2000,
    );

    expect(layout.enabled).toBe(true);
    expect(layout.pinnedIndices).toEqual([0]);
    expect(layout.virtualIndices).toEqual([1, 2]);
    expect(layout.paddingLeft).toBe(40);
    expect(layout.paddingRight).toBe(2000 - 160);
  });
});
