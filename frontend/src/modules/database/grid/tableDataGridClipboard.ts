import { resolvePreviewRowKey } from "../workspace/dbWorkspaceState";
import { matrixToDelimited, type DelimitedTextFormat } from "../shared/delimitedText";
import { ROW_NUM_COL_ID, TRANSPOSE_FIELD_COL } from "./tableDataGridConstants";
import { normalizeRange, type CellRange } from "./tableDataGridSelection";

export function extractRowValuesFromIndex(
  rowIndex: number,
  tableRows: { index: number; original: Record<string, unknown> }[],
  effectiveColumns: string[],
  pkCols: { name: string }[],
  displayCellOverrides?: Record<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const tableRow = tableRows[rowIndex];
  if (!tableRow) return null;
  const rowKey = resolvePreviewRowKey(tableRow.original, pkCols);
  const overrides = rowKey ? displayCellOverrides?.[rowKey] : undefined;
  const data: Record<string, unknown> = {};
  for (const col of effectiveColumns) {
    data[col] = overrides?.[col] !== undefined ? overrides[col] : tableRow.original[col];
  }
  return data;
}

export function buildCellRangeClipboardText(
  range: CellRange,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  opts: {
    pkCols: { name: string }[];
    transposed: boolean;
    displayCellOverrides?: Record<string, Record<string, unknown>>;
    format?: DelimitedTextFormat;
  },
): string {
  const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
  const colIds: string[] = [];
  for (let c = minCol; c <= maxCol; c++) {
    const col = leafColumns[c];
    if (!col || col.id === ROW_NUM_COL_ID) continue;
    colIds.push(col.id);
  }
  if (colIds.length === 0) return "";

  const matrix: unknown[][] = [];
  for (let r = minRow; r <= maxRow; r++) {
    const tableRow = tableRows[r];
    if (!tableRow) continue;
    const rowKey = opts.transposed
      ? String(tableRow.original[TRANSPOSE_FIELD_COL] ?? "")
      : resolvePreviewRowKey(tableRow.original, opts.pkCols);
    const overrideForRow = rowKey ? opts.displayCellOverrides?.[rowKey] : undefined;
    const line: unknown[] = [];
    for (const colId of colIds) {
      const overrideValue = overrideForRow?.[colId];
      line.push(overrideValue !== undefined ? overrideValue : tableRow.original[colId]);
    }
    matrix.push(line);
  }
  return matrixToDelimited(matrix, opts.format ?? "csv");
}

/** @deprecated 使用 buildCellRangeClipboardText */
export function buildCellRangeCsv(
  range: CellRange,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  opts: {
    pkCols: { name: string }[];
    transposed: boolean;
    displayCellOverrides?: Record<string, Record<string, unknown>>;
  },
): string {
  return buildCellRangeClipboardText(range, leafColumns, tableRows, { ...opts, format: "csv" });
}

export function buildSelectedRowsClipboardText(
  selectedRows: ReadonlySet<number>,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  opts: {
    pkCols: { name: string }[];
    transposed: boolean;
    displayCellOverrides?: Record<string, Record<string, unknown>>;
    format?: DelimitedTextFormat;
  },
): string {
  if (selectedRows.size === 0) return "";
  const colIds = leafColumns.map((col) => col.id).filter((id) => id !== ROW_NUM_COL_ID);
  if (colIds.length === 0) return "";

  const matrix: unknown[][] = [];
  for (const rowIndex of [...selectedRows].sort((a, b) => a - b)) {
    const tableRow = tableRows[rowIndex];
    if (!tableRow) continue;
    const rowKey = opts.transposed
      ? String(tableRow.original[TRANSPOSE_FIELD_COL] ?? "")
      : resolvePreviewRowKey(tableRow.original, opts.pkCols);
    const overrideForRow = rowKey ? opts.displayCellOverrides?.[rowKey] : undefined;
    const line: unknown[] = [];
    for (const colId of colIds) {
      const overrideValue = overrideForRow?.[colId];
      line.push(overrideValue !== undefined ? overrideValue : tableRow.original[colId]);
    }
    matrix.push(line);
  }
  return matrixToDelimited(matrix, opts.format ?? "csv");
}

/** @deprecated 使用 buildSelectedRowsClipboardText */
export function buildSelectedRowsCsv(
  selectedRows: ReadonlySet<number>,
  leafColumns: { id: string }[],
  tableRows: { index: number; original: Record<string, unknown> }[],
  opts: {
    pkCols: { name: string }[];
    transposed: boolean;
    displayCellOverrides?: Record<string, Record<string, unknown>>;
  },
): string {
  return buildSelectedRowsClipboardText(selectedRows, leafColumns, tableRows, { ...opts, format: "csv" });
}
