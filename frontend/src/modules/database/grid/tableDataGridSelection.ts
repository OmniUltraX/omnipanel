import { ROW_NUM_COL_ID, TRANSPOSE_FIELD_COL } from "./tableDataGridConstants";
import { resolveTransposedDataCellContext } from "./tableDataGridTranspose";
import type { TableDataGridActiveCell } from "./tableDataGridTypes";

export type CellPos = { row: number; col: number };
export type CellRange = { start: CellPos; end: CellPos };

export function normalizeRange(range: CellRange): {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
} {
  return {
    minRow: Math.min(range.start.row, range.end.row),
    maxRow: Math.max(range.start.row, range.end.row),
    minCol: Math.min(range.start.col, range.end.col),
    maxCol: Math.max(range.start.col, range.end.col),
  };
}

export function isCellInRange(row: number, col: number, range: CellRange | null): boolean {
  if (!range) return false;
  const r = normalizeRange(range);
  return row >= r.minRow && row <= r.maxRow && col >= r.minCol && col <= r.maxCol;
}

export function isCellSelected(
  row: number,
  col: number,
  range: CellRange | null,
  extraRows: ReadonlySet<number>,
  leafColumnCount: number,
): boolean {
  if (extraRows.size > 0 && extraRows.has(row) && col >= 0 && col < leafColumnCount) {
    return true;
  }
  return isCellInRange(row, col, range);
}

/** 选区是否覆盖该行（用于行级 memo） */
export function selectionAffectsRow(
  rowIndex: number,
  range: CellRange | null,
  extraRows: ReadonlySet<number>,
  _leafColumnCount: number,
): boolean {
  if (extraRows.has(rowIndex)) return true;
  if (!range) return false;
  const r = normalizeRange(range);
  return rowIndex >= r.minRow && rowIndex <= r.maxRow;
}

/** 该行上各单元格的选中态是否与上一帧相同 */
export function rowSelectionStateEqual(
  rowIndex: number,
  prevRange: CellRange | null,
  prevExtraRows: ReadonlySet<number>,
  nextRange: CellRange | null,
  nextExtraRows: ReadonlySet<number>,
  leafColumnCount: number,
): boolean {
  for (let col = 0; col < leafColumnCount; col += 1) {
    if (
      isCellSelected(rowIndex, col, prevRange, prevExtraRows, leafColumnCount) !==
      isCellSelected(rowIndex, col, nextRange, nextExtraRows, leafColumnCount)
    ) {
      return false;
    }
  }
  return true;
}

export function isHeaderInColumnSelection(
  headerColIdx: number,
  range: CellRange | null,
  rowCount: number,
): boolean {
  if (!range || rowCount <= 0) return false;
  const r = normalizeRange(range);
  const spansAllRows = r.minRow === 0 && r.maxRow === rowCount - 1;
  if (!spansAllRows) return false;
  return headerColIdx >= r.minCol && headerColIdx <= r.maxCol;
}

export function isFullRowSelection(range: CellRange, leafColumnCount: number): boolean {
  const r = normalizeRange(range);
  if (r.minRow !== r.maxRow) return false;
  return r.minCol === 0 && r.maxCol === leafColumnCount - 1;
}

export function isFullWidthRowRange(range: CellRange, leafColumnCount: number): boolean {
  if (leafColumnCount <= 0) return false;
  const r = normalizeRange(range);
  return r.minCol === 0 && r.maxCol === leafColumnCount - 1;
}

export function rowsInFullRowRange(range: CellRange, leafColumnCount: number): Set<number> {
  const rows = new Set<number>();
  if (!isFullWidthRowRange(range, leafColumnCount)) return rows;
  const r = normalizeRange(range);
  for (let i = r.minRow; i <= r.maxRow; i += 1) {
    rows.add(i);
  }
  return rows;
}

export function collectSelectedRowIndices(
  cellRange: CellRange | null,
  selectedRows: ReadonlySet<number>,
  leafColumnCount: number,
): number[] {
  const merged = new Set<number>();
  if (selectedRows.size > 0) {
    for (const rowIndex of selectedRows) {
      merged.add(rowIndex);
    }
  } else if (cellRange && isFullWidthRowRange(cellRange, leafColumnCount)) {
    for (const rowIndex of rowsInFullRowRange(cellRange, leafColumnCount)) {
      merged.add(rowIndex);
    }
  }
  return [...merged].sort((a, b) => a - b);
}

export function resolveCellTargetAt(
  row: number,
  col: number,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  opts: {
    transposed: boolean;
    rows: Record<string, unknown>[];
  },
): TableDataGridActiveCell | null {
  const column = leafColumns[col];
  if (!column || column.id === ROW_NUM_COL_ID) return null;
  if (opts.transposed && column.id === TRANSPOSE_FIELD_COL) return null;

  const tableRow = tableRows[row];
  if (!tableRow) return null;

  if (opts.transposed) {
    const mapped = resolveTransposedDataCellContext(column.id, tableRow.original, opts.rows);
    if (!mapped) return null;
    return {
      rowIndex: mapped.originalRowIndex,
      column: mapped.fieldColumn,
      row: mapped.originalRow,
    };
  }

  return {
    rowIndex: tableRow.index,
    column: column.id,
    row: tableRow.original,
  };
}

export function collectSelectedCellTargets(
  cellRange: CellRange | null,
  selectedRows: ReadonlySet<number>,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  leafColumnCount: number,
  opts: {
    transposed: boolean;
    rows: Record<string, unknown>[];
  },
): TableDataGridActiveCell[] {
  const targets: TableDataGridActiveCell[] = [];

  if (cellRange) {
    const { minRow, maxRow, minCol, maxCol } = normalizeRange(cellRange);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const target = resolveCellTargetAt(row, col, leafColumns, tableRows, opts);
        if (target) targets.push(target);
      }
    }
    return targets;
  }

  if (selectedRows.size > 0) {
    const dataColIndexes = leafColumns
      .map((col, index) => ({ col, index }))
      .filter(({ col }) => col.id !== ROW_NUM_COL_ID)
      .map(({ index }) => index);
    for (const row of [...selectedRows].sort((a, b) => a - b)) {
      for (const col of dataColIndexes) {
        const target = resolveCellTargetAt(row, col, leafColumns, tableRows, opts);
        if (target) targets.push(target);
      }
    }
    return targets;
  }

  if (leafColumnCount <= 0) {
    return targets;
  }
  return targets;
}

export function resolvePasteBounds(
  cellRange: CellRange | null,
  selectedRows: ReadonlySet<number>,
  leafColumnCount: number,
  rowCount: number,
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  if (rowCount <= 0 || leafColumnCount <= 0) return null;

  if (cellRange) {
    const { minRow, maxRow, minCol, maxCol } = normalizeRange(cellRange);
    return {
      startRow: minRow,
      startCol: minCol,
      endRow: maxRow,
      endCol: maxCol,
    };
  }

  if (selectedRows.size > 0) {
    const sorted = [...selectedRows].sort((a, b) => a - b);
    return {
      startRow: sorted[0] ?? 0,
      startCol: 0,
      endRow: sorted[sorted.length - 1] ?? 0,
      endCol: leafColumnCount - 1,
    };
  }

  return null;
}

export function resolveSingleSelectedCell(
  range: CellRange | null,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  opts: {
    transposed: boolean;
    rows: Record<string, unknown>[];
  },
): TableDataGridActiveCell | null {
  if (!range) return null;
  const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
  if (minRow !== maxRow || minCol !== maxCol) return null;
  return resolveCellTargetAt(minRow, minCol, leafColumns, tableRows, opts);
}

export function selectionTargetKey(cell: TableDataGridActiveCell | null): string | null {
  if (!cell) return null;
  return `${cell.rowIndex}:${cell.column}`;
}

export function selectionTargetsKey(cells: readonly TableDataGridActiveCell[]): string {
  if (cells.length === 0) return "";
  return cells
    .map((cell) => `${cell.rowIndex}:${cell.column}`)
    .sort()
    .join("|");
}

export function isEditableTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
