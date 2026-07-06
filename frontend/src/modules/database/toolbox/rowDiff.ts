import { countTable, previewTable, type DbColumnMeta, type DbConnectionConfig } from "../api";
import type { TableRowDiff } from "./types";

const PAGE_SIZE = 500;
/** 详情面板最多展示的差异行数 */
export const MAX_DIFF_DETAIL_ROWS = 100;

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildRowKey(
  row: Record<string, unknown>,
  pkColumns: string[],
  allColumns: string[],
): string {
  const keys = pkColumns.length > 0 ? pkColumns : allColumns;
  return keys.map((col) => normalizeValue(row[col])).join("\0");
}

export function formatRowDisplayKey(
  row: Record<string, unknown>,
  pkColumns: string[],
  allColumns: string[],
): string {
  const keys = pkColumns.length > 0 ? pkColumns : allColumns.slice(0, 3);
  return keys.map((col) => `${col}=${normalizeValue(row[col])}`).join(", ");
}

function compareRowFields(
  sourceRow: Record<string, unknown>,
  targetRow: Record<string, unknown>,
  columns: string[],
): string[] {
  const changed: string[] = [];
  for (const col of columns) {
    if (normalizeValue(sourceRow[col]) !== normalizeValue(targetRow[col])) {
      changed.push(col);
    }
  }
  return changed;
}

async function fetchAllRows(
  connection: DbConnectionConfig,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const db = connection.database?.trim() ?? "";
  const total = await countTable(connection, tableName, db || undefined);
  if (total <= 0) return [];

  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const page = await previewTable(connection, tableName, PAGE_SIZE, offset);
    rows.push(...page.rows);
  }
  return rows;
}

export interface TableRowCompareResult {
  status: "match" | "diff";
  diffRows: number;
  diffs: TableRowDiff[];
  truncated?: boolean;
}

function buildTableRowDiffs(
  sourceMap: Map<string, Record<string, unknown>>,
  targetMap: Map<string, Record<string, unknown>>,
  pkColumns: string[],
  allColumnNames: string[],
  maxDetailRows: number | null,
): TableRowCompareResult {
  const diffs: TableRowDiff[] = [];
  let diffCount = 0;

  for (const [key, sourceRow] of sourceMap) {
    const targetRow = targetMap.get(key);
    if (!targetRow) {
      diffCount += 1;
      if (maxDetailRows === null || diffs.length < maxDetailRows) {
        diffs.push({
          rowKey: key,
          kind: "sourceOnly",
          sourceRow,
          displayKey: formatRowDisplayKey(sourceRow, pkColumns, allColumnNames),
        });
      }
      continue;
    }

    const changedFields = compareRowFields(sourceRow, targetRow, allColumnNames);
    if (changedFields.length > 0) {
      diffCount += 1;
      if (maxDetailRows === null || diffs.length < maxDetailRows) {
        diffs.push({
          rowKey: key,
          kind: "changed",
          changedFields,
          sourceRow,
          targetRow,
          displayKey: formatRowDisplayKey(sourceRow, pkColumns, allColumnNames),
        });
      }
    }
  }

  for (const [key, targetRow] of targetMap) {
    if (sourceMap.has(key)) continue;
    diffCount += 1;
    if (maxDetailRows === null || diffs.length < maxDetailRows) {
      diffs.push({
        rowKey: key,
        kind: "targetOnly",
        targetRow,
        displayKey: formatRowDisplayKey(targetRow, pkColumns, allColumnNames),
      });
    }
  }

  if (diffCount === 0) {
    return { status: "match", diffRows: 0, diffs: [] };
  }

  return {
    status: "diff",
    diffRows: diffCount,
    diffs,
    truncated: maxDetailRows !== null && diffCount > maxDetailRows,
  };
}

async function loadTableRowCompareMaps(
  sourceConn: DbConnectionConfig,
  targetConn: DbConnectionConfig,
  tableName: string,
  columns: DbColumnMeta[],
) {
  const pkColumns = columns.filter((col) => col.isPk).map((col) => col.name);
  const allColumnNames = columns.map((col) => col.name);

  const [sourceRows, targetRows] = await Promise.all([
    fetchAllRows(sourceConn, tableName),
    fetchAllRows(targetConn, tableName),
  ]);

  const sourceMap = new Map<string, Record<string, unknown>>();
  for (const row of sourceRows) {
    sourceMap.set(buildRowKey(row, pkColumns, allColumnNames), row);
  }

  const targetMap = new Map<string, Record<string, unknown>>();
  for (const row of targetRows) {
    targetMap.set(buildRowKey(row, pkColumns, allColumnNames), row);
  }

  return { sourceMap, targetMap, pkColumns, allColumnNames };
}

export async function compareTableRows(
  sourceConn: DbConnectionConfig,
  targetConn: DbConnectionConfig,
  tableName: string,
  columns: DbColumnMeta[],
): Promise<TableRowCompareResult> {
  const { sourceMap, targetMap, pkColumns, allColumnNames } = await loadTableRowCompareMaps(
    sourceConn,
    targetConn,
    tableName,
    columns,
  );
  return buildTableRowDiffs(sourceMap, targetMap, pkColumns, allColumnNames, MAX_DIFF_DETAIL_ROWS);
}
