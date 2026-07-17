import { invoke } from "@tauri-apps/api/core";
import type { DbConnectionConfig } from "../api";
import type { QueryResult } from "../workspace/dbWorkspaceState";
import { makeQueryRunId } from "../sql/queryRun";
import type { TableSchema } from "../types";
import type { TableColumnRelation } from "./tableColumnRelation";
import {
  relationDisplayColumnId,
  resolveRelationDisplayFieldName,
} from "./tableColumnRelation";

function quoteSqlIdentifier(name: string, dbType: string): string {
  const normalized = dbType.toLowerCase();
  const safe =
    normalized === "mysql" || normalized === "mariadb"
      ? name.replace(/`/g, "")
      : name.replace(/"/g, "");
  if (normalized === "mysql" || normalized === "mariadb") {
    return `\`${safe}\``;
  }
  return `"${safe}"`;
}

function quoteSqlLiteral(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function normalizeRelationLookupKey(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 关联 lookup 依赖指纹：只序列化各关联源列的去重取值。
 * 普通单元格编辑（非 FK 源列）不会改变指纹，从而避免误触发 IPC。
 */
export function buildRelationLookupFingerprint(
  relations: Record<string, TableColumnRelation>,
  rows: Record<string, unknown>[],
  resolveSourceValue?: (row: Record<string, unknown>, sourceColumn: string) => unknown,
): string {
  const sourceColumns = Object.keys(relations).sort();
  if (sourceColumns.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const sourceColumn of sourceColumns) {
    const keys = new Set<string>();
    for (const row of rows) {
      const value = resolveSourceValue
        ? resolveSourceValue(row, sourceColumn)
        : row[sourceColumn];
      const key = normalizeRelationLookupKey(value);
      if (key) {
        keys.add(key);
      }
    }
    parts.push(`${sourceColumn}:${[...keys].sort().join(",")}`);
  }
  return parts.join("|");
}

function resolveColumnIndex(columns: string[], name: string, fallback: number): number {
  const lower = name.toLowerCase();
  const index = columns.findIndex((column) => column.toLowerCase() === lower);
  return index >= 0 ? index : fallback;
}

function buildRelationLookupSql(
  dbType: string,
  relation: TableColumnRelation,
  displayField: string,
  values: unknown[],
): string | null {
  const distinctKeys = new Set<string>();
  const distinctValues: unknown[] = [];
  for (const value of values) {
    const key = normalizeRelationLookupKey(value);
    if (!key || distinctKeys.has(key)) continue;
    distinctKeys.add(key);
    distinctValues.push(value);
  }
  if (distinctValues.length === 0) return null;

  const tableRef = quoteSqlIdentifier(relation.tableName, dbType);
  const fieldRef = quoteSqlIdentifier(relation.fieldName, dbType);
  const displayRef = quoteSqlIdentifier(displayField, dbType);
  const inList = distinctValues.map((value) => quoteSqlLiteral(value)).join(", ");
  return `SELECT ${fieldRef}, ${displayRef} FROM ${tableRef} WHERE ${fieldRef} IN (${inList})`;
}

export async function fetchColumnRelationLookups(
  connection: DbConnectionConfig,
  database: string,
  dbType: string,
  relations: Record<string, TableColumnRelation>,
  relationTables: TableSchema[] | undefined,
  rows: Record<string, unknown>[],
): Promise<Record<string, Map<string, unknown>>> {
  const result: Record<string, Map<string, unknown>> = {};
  const tableByName = new Map((relationTables ?? []).map((table) => [table.name, table]));

  for (const [sourceColumn, relation] of Object.entries(relations)) {
    const columnId = relationDisplayColumnId(sourceColumn);
    const lookupMap = new Map<string, unknown>();
    result[columnId] = lookupMap;

    const relatedTable = tableByName.get(relation.tableName);
    const displayField = resolveRelationDisplayFieldName(relation, relatedTable);
    const values = rows
      .map((row) => row[sourceColumn])
      .filter((value) => value != null && value !== "");

    const sql = buildRelationLookupSql(dbType, relation, displayField, values);
    if (!sql) continue;

    try {
      const queryResult = await invoke<QueryResult>("db_execute_query", {
        connection: { ...connection, database },
        sql,
        runId: makeQueryRunId(),
        limit: Math.max(values.length, 500),
        offset: 0,
      });
      const fieldIndex = resolveColumnIndex(queryResult.columns, relation.fieldName, 0);
      const displayIndex = resolveColumnIndex(queryResult.columns, displayField, 1);
      for (const row of queryResult.rows) {
        const key = normalizeRelationLookupKey(row[fieldIndex]);
        if (!key) continue;
        lookupMap.set(key, row[displayIndex]);
      }
    } catch {
      // 关联查询失败时保留空映射，不影响主表预览
    }
  }

  return result;
}
