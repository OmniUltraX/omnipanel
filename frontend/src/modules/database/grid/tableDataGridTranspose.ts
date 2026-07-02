import type { DbColumnMeta } from "../api";
import { resolvePreviewRowKey } from "../workspace/dbWorkspaceState";
import { TRANSPOSE_FIELD_COL, transposeRowColId } from "./tableDataGridConstants";

export function buildTransposeRowHeader(
  row: Record<string, unknown>,
  rowIndex: number,
  page: number,
  pageSize: number,
  columnMeta?: DbColumnMeta[],
): string {
  const pkCols = (columnMeta ?? []).filter((c) => c.isPk);
  if (pkCols.length > 0) {
    const label = pkCols
      .map((pk) => row[pk.name])
      .filter((v) => v != null && v !== "")
      .map(String)
      .join(", ");
    if (label) return label;
  }
  return String(page * pageSize + rowIndex + 1);
}

export function transposeGridData(
  columns: string[],
  rows: Record<string, unknown>[],
  page: number,
  pageSize: number,
  columnMeta?: DbColumnMeta[],
): {
  columns: string[];
  rows: Record<string, unknown>[];
  rowHeaders: string[];
} {
  const rowHeaders = rows.map((row, i) =>
    buildTransposeRowHeader(row, i, page, pageSize, columnMeta),
  );
  const transposedColumns = [TRANSPOSE_FIELD_COL, ...rows.map((_, i) => transposeRowColId(i))];
  const transposedRows = columns.map((col) => {
    const record: Record<string, unknown> = { [TRANSPOSE_FIELD_COL]: col };
    rows.forEach((dataRow, i) => {
      record[transposeRowColId(i)] = dataRow[col];
    });
    return record;
  });
  return { columns: transposedColumns, rows: transposedRows, rowHeaders };
}

export function transposeDirtyState(
  rows: Record<string, unknown>[],
  columnMeta: DbColumnMeta[] | undefined,
  dirtyRowKeys: Set<string> | undefined,
  cellOverrides: Record<string, Record<string, unknown>> | undefined,
): {
  dirtyRowKeys: Set<string>;
  cellOverrides: Record<string, Record<string, unknown>>;
} {
  const transposedDirty = new Set<string>();
  const transposedOverrides: Record<string, Record<string, unknown>> = {};
  if (!dirtyRowKeys?.size || !cellOverrides) {
    return { dirtyRowKeys: transposedDirty, cellOverrides: transposedOverrides };
  }

  const pkCols = (columnMeta ?? []).filter((c) => c.isPk);
  rows.forEach((row, rowIndex) => {
    const rowKey = resolvePreviewRowKey(row, pkCols);
    if (!rowKey || !dirtyRowKeys.has(rowKey)) return;
    const overrides = cellOverrides[rowKey];
    if (!overrides) return;
    for (const [col, value] of Object.entries(overrides)) {
      transposedDirty.add(col);
      if (!transposedOverrides[col]) transposedOverrides[col] = {};
      transposedOverrides[col][transposeRowColId(rowIndex)] = value;
    }
  });

  return { dirtyRowKeys: transposedDirty, cellOverrides: transposedOverrides };
}

export function resolveTransposedDataCellContext(
  cellColumnId: string,
  transposedRow: Record<string, unknown>,
  sourceRows: Record<string, unknown>[],
): {
  originalRowIndex: number;
  originalRow: Record<string, unknown>;
  fieldColumn: string;
} | null {
  if (!cellColumnId.startsWith("__row__")) return null;
  const originalRowIndex = parseInt(cellColumnId.replace("__row__", ""), 10);
  if (Number.isNaN(originalRowIndex) || sourceRows[originalRowIndex] == null) return null;
  return {
    originalRowIndex,
    originalRow: sourceRows[originalRowIndex],
    fieldColumn: String(transposedRow[TRANSPOSE_FIELD_COL] ?? ""),
  };
}
