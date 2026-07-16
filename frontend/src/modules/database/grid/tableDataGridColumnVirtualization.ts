import type { Column } from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";

import {
  COLUMN_VIRTUALIZE_OVERSCAN,
  COLUMN_VIRTUALIZE_THRESHOLD,
  ROW_NUM_COL_ID,
  TRANSPOSE_FIELD_COL,
} from "./tableDataGridConstants";

export { COLUMN_VIRTUALIZE_THRESHOLD, COLUMN_VIRTUALIZE_OVERSCAN };

export type ColumnVirtualizationLayout = {
  enabled: boolean;
  pinnedIndices: number[];
  virtualIndices: number[];
  paddingLeft: number;
  paddingRight: number;
  visibleCellCount: number;
};

export function isPinnedGridColumn(columnId: string, transposed: boolean): boolean {
  if (transposed) {
    return columnId === TRANSPOSE_FIELD_COL;
  }
  return columnId === ROW_NUM_COL_ID;
}

export function shouldVirtualizeGridColumns(leafColumnCount: number): boolean {
  return leafColumnCount > COLUMN_VIRTUALIZE_THRESHOLD;
}

export function buildVirtualizableColumnIndices(
  leafColumns: Column<Record<string, unknown>, unknown>[],
  transposed: boolean,
): number[] {
  const indices: number[] = [];
  for (let index = 0; index < leafColumns.length; index += 1) {
    const column = leafColumns[index]!;
    if (!isPinnedGridColumn(column.id, transposed)) {
      indices.push(index);
    }
  }
  return indices;
}

export function buildPinnedColumnIndices(
  leafColumns: Column<Record<string, unknown>, unknown>[],
  transposed: boolean,
): number[] {
  const indices: number[] = [];
  for (let index = 0; index < leafColumns.length; index += 1) {
    const column = leafColumns[index]!;
    if (isPinnedGridColumn(column.id, transposed)) {
      indices.push(index);
    }
  }
  return indices;
}

export function buildColumnVirtualizationLayout(
  leafColumns: Column<Record<string, unknown>, unknown>[],
  transposed: boolean,
  virtualItems: VirtualItem[],
  virtualizableIndices: number[],
  totalVirtualSize: number,
): ColumnVirtualizationLayout {
  const pinnedIndices = buildPinnedColumnIndices(leafColumns, transposed);
  // 列虚拟化未接线（无 virtualItems）或列数未超阈值时：渲染全部列，避免只剩行号列导致「表头有、格子全黑」
  if (
    !shouldVirtualizeGridColumns(leafColumns.length) ||
    virtualItems.length === 0 ||
    virtualizableIndices.length === 0
  ) {
    return {
      enabled: false,
      pinnedIndices,
      virtualIndices: leafColumns.map((_, index) => index),
      paddingLeft: 0,
      paddingRight: 0,
      visibleCellCount: leafColumns.length,
    };
  }

  const virtualIndices = virtualItems.map(
    (item) => virtualizableIndices[item.index] ?? item.index,
  );
  const paddingLeft = virtualItems[0]!.start;
  const paddingRight = totalVirtualSize - virtualItems[virtualItems.length - 1]!.end;
  const spacerCount = (paddingLeft > 0 ? 1 : 0) + (paddingRight > 0 ? 1 : 0);

  return {
    enabled: true,
    pinnedIndices,
    virtualIndices,
    paddingLeft,
    paddingRight,
    visibleCellCount: pinnedIndices.length + virtualIndices.length + spacerCount,
  };
}
