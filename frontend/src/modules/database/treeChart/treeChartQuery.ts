import { invoke } from "@tauri-apps/api/core";
import type { RuleGroupType } from "react-querybuilder";
import type { DbConnectionConfig } from "../api";
import type { QueryResult } from "../workspace/dbWorkspaceState";
import { makeQueryRunId } from "../sql/queryRun";
import { formatFilterWhere, getFilterColumnNames } from "../grid/tablePreviewFilter";
import type { TreeChartFieldSelection, TreeChartRow } from "./treeChartTypes";
import {
  isFirstTreeChartPanelSelection,
  isJunctionTableSelection,
} from "./treeChartTypes";

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

function quoteSqlLiteral(value: string): string {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function formatCellValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function buildTreeChartWhereClause(
  dbType: string,
  filter?: RuleGroupType | null,
  extraConditions: string[] = [],
): string {
  const conditions: string[] = [];
  const filterSql = formatFilterWhere(filter, dbType);
  if (filterSql) {
    conditions.push(filterSql);
  }
  for (const condition of extraConditions) {
    if (condition) {
      conditions.push(condition);
    }
  }
  if (conditions.length === 0) {
    return "";
  }
  return ` WHERE ${conditions.join(" AND ")}`;
}

function qualifyFilterWhere(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  tableAlias: string,
): string | undefined {
  const sql = formatFilterWhere(filter, dbType);
  if (!sql) {
    return undefined;
  }
  const columns = getFilterColumnNames(filter ?? { combinator: "and", rules: [] });
  let qualified = sql;
  for (const column of [...columns].sort((a, b) => b.length - a.length)) {
    const quoted = quoteSqlIdentifier(column, dbType);
    qualified = qualified.split(quoted).join(`${tableAlias}.${quoted}`);
  }
  return qualified;
}

function buildJunctionFilteredQuery(
  dbType: string,
  selection: TreeChartFieldSelection,
  parentDownstreamValue: string,
): string {
  const junction = selection.junction;
  if (!junction) {
    throw new Error("Junction config is required for junction table query");
  }
  const tmTable = quoteSqlIdentifier(junction.junctionTableName, dbType);
  const t2Table = quoteSqlIdentifier(selection.tableName, dbType);
  const tmT1 = quoteSqlIdentifier(junction.junctionToUpstreamField, dbType);
  const tmT2 = quoteSqlIdentifier(junction.junctionToDownstreamField, dbType);
  const t2Join = quoteSqlIdentifier(junction.downstreamTableJoinField, dbType);
  const label = quoteSqlIdentifier(selection.labelField, dbType);
  const downstream = quoteSqlIdentifier(selection.downstreamRelationField, dbType);
  const literal = quoteSqlLiteral(parentDownstreamValue);

  const conditions: string[] = [`tm.${tmT1} = ${literal}`];
  const filterSql = qualifyFilterWhere(selection.filter, dbType, "t2");
  if (filterSql) {
    conditions.push(filterSql);
  }

  return (
    `SELECT t2.${label} AS ${label}, t2.${downstream} AS ${downstream} ` +
    `FROM ${tmTable} AS tm ` +
    `INNER JOIN ${t2Table} AS t2 ON tm.${tmT2} = t2.${t2Join} ` +
    `WHERE ${conditions.join(" AND ")}`
  );
}

function buildJunctionDownstreamCountQuery(
  dbType: string,
  downstreamSelection: TreeChartFieldSelection,
): string {
  const junction = downstreamSelection.junction;
  if (!junction) {
    throw new Error("Junction config is required for junction downstream count query");
  }
  const tmTable = quoteSqlIdentifier(junction.junctionTableName, dbType);
  const t2Table = quoteSqlIdentifier(downstreamSelection.tableName, dbType);
  const tmT1 = quoteSqlIdentifier(junction.junctionToUpstreamField, dbType);
  const tmT2 = quoteSqlIdentifier(junction.junctionToDownstreamField, dbType);
  const t2Join = quoteSqlIdentifier(junction.downstreamTableJoinField, dbType);

  const conditions: string[] = [];
  const filterSql = qualifyFilterWhere(downstreamSelection.filter, dbType, "t2");
  if (filterSql) {
    conditions.push(filterSql);
  }
  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  return (
    `SELECT tm.${tmT1} AS ${tmT1}, COUNT(*) AS __tree_chart_cnt ` +
    `FROM ${tmTable} AS tm ` +
    `INNER JOIN ${t2Table} AS t2 ON tm.${tmT2} = t2.${t2Join}` +
    `${whereSql} GROUP BY tm.${tmT1}`
  );
}

export function buildTreeChartQuery(
  dbType: string,
  selection: TreeChartFieldSelection,
): string {
  const table = quoteSqlIdentifier(selection.tableName, dbType);
  const label = quoteSqlIdentifier(selection.labelField, dbType);
  const downstream = quoteSqlIdentifier(selection.downstreamRelationField, dbType);
  const whereSql = buildTreeChartWhereClause(dbType, selection.filter);
  if (!isFirstTreeChartPanelSelection(selection) && selection.upstreamRelationField) {
    const upstream = quoteSqlIdentifier(selection.upstreamRelationField, dbType);
    return `SELECT ${upstream}, ${label}, ${downstream} FROM ${table}${whereSql}`;
  }
  return `SELECT ${label}, ${downstream} FROM ${table}${whereSql}`;
}

export function buildTreeChartFilteredQuery(
  dbType: string,
  selection: TreeChartFieldSelection,
  parentDownstreamValue: string,
): string {
  if (isJunctionTableSelection(selection)) {
    return buildJunctionFilteredQuery(dbType, selection, parentDownstreamValue);
  }
  if (!selection.upstreamRelationField) {
    throw new Error("Upstream relation field is required for filtered query");
  }
  const table = quoteSqlIdentifier(selection.tableName, dbType);
  const label = quoteSqlIdentifier(selection.labelField, dbType);
  const downstream = quoteSqlIdentifier(selection.downstreamRelationField, dbType);
  const upstream = quoteSqlIdentifier(selection.upstreamRelationField, dbType);
  const literal = quoteSqlLiteral(parentDownstreamValue);
  const whereSql = buildTreeChartWhereClause(dbType, selection.filter, [
    `${upstream} = ${literal}`,
  ]);
  return `SELECT ${label}, ${downstream} FROM ${table}${whereSql}`;
}

export function buildTreeChartDownstreamCountQuery(
  dbType: string,
  downstreamSelection: TreeChartFieldSelection,
): string {
  if (isJunctionTableSelection(downstreamSelection)) {
    return buildJunctionDownstreamCountQuery(dbType, downstreamSelection);
  }
  if (!downstreamSelection.upstreamRelationField) {
    throw new Error("Upstream relation field is required for downstream count query");
  }
  const table = quoteSqlIdentifier(downstreamSelection.tableName, dbType);
  const upstream = quoteSqlIdentifier(downstreamSelection.upstreamRelationField, dbType);
  const whereSql = buildTreeChartWhereClause(dbType, downstreamSelection.filter);
  return `SELECT ${upstream}, COUNT(*) AS __tree_chart_cnt FROM ${table}${whereSql} GROUP BY ${upstream}`;
}

function resolveColumnIndex(columns: string[], fieldName: string, fallback: number): number {
  const index = columns.findIndex((column) => column.toLowerCase() === fieldName.toLowerCase());
  return index >= 0 ? index : fallback;
}

function mapQueryRows(
  result: QueryResult,
  selection: TreeChartFieldSelection,
  includeUpstream: boolean,
): TreeChartRow[] {
  if (includeUpstream && selection.upstreamRelationField) {
    const upstreamIndex = resolveColumnIndex(result.columns, selection.upstreamRelationField, 0);
    const labelIndex = resolveColumnIndex(result.columns, selection.labelField, 1);
    const downstreamIndex = resolveColumnIndex(
      result.columns,
      selection.downstreamRelationField,
      2,
    );
    return result.rows.map((row) => ({
      upstreamRelation: formatCellValue(row[upstreamIndex]),
      label: formatCellValue(row[labelIndex]),
      downstreamRelation: formatCellValue(row[downstreamIndex]),
    }));
  }

  const labelIndex = resolveColumnIndex(result.columns, selection.labelField, 0);
  const downstreamIndex = resolveColumnIndex(
    result.columns,
    selection.downstreamRelationField,
    1,
  );

  return result.rows.map((row) => ({
    label: formatCellValue(row[labelIndex]),
    downstreamRelation: formatCellValue(row[downstreamIndex]),
  }));
}

async function executeTreeChartQuery(
  connection: DbConnectionConfig,
  database: string,
  sql: string,
  limit = 5000,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_execute_query", {
    connection: { ...connection, database },
    sql,
    runId: makeQueryRunId(),
    limit,
    offset: 0,
  });
}

export async function fetchTreeChartRows(
  connection: DbConnectionConfig,
  database: string,
  selection: TreeChartFieldSelection,
  limit = 5000,
): Promise<TreeChartRow[]> {
  const sql = buildTreeChartQuery(connection.db_type, selection);
  const result = await executeTreeChartQuery(connection, database, sql, limit);
  const includeUpstream =
    !isFirstTreeChartPanelSelection(selection) && Boolean(selection.upstreamRelationField);
  return mapQueryRows(result, selection, includeUpstream);
}

export async function fetchTreeChartFilteredRows(
  connection: DbConnectionConfig,
  database: string,
  selection: TreeChartFieldSelection,
  parentDownstreamValue: string,
  limit = 5000,
): Promise<TreeChartRow[]> {
  const sql = buildTreeChartFilteredQuery(
    connection.db_type,
    selection,
    parentDownstreamValue,
  );
  const result = await executeTreeChartQuery(connection, database, sql, limit);
  return mapQueryRows(result, selection, false);
}

export async function fetchTreeChartDownstreamCountMap(
  connection: DbConnectionConfig,
  database: string,
  downstreamSelection: TreeChartFieldSelection,
): Promise<Map<string, number>> {
  const sql = buildTreeChartDownstreamCountQuery(connection.db_type, downstreamSelection);
  const result = await executeTreeChartQuery(connection, database, sql, 100_000);
  const upstreamField = isJunctionTableSelection(downstreamSelection)
    ? downstreamSelection.junction!.junctionToUpstreamField
    : downstreamSelection.upstreamRelationField!;
  const upstreamIndex = resolveColumnIndex(result.columns, upstreamField, 0);
  const countIndex = result.columns.findIndex(
    (column) => column.toLowerCase() === "__tree_chart_cnt",
  );
  const resolvedCountIndex = countIndex >= 0 ? countIndex : 1;

  const map = new Map<string, number>();
  for (const row of result.rows) {
    const key = formatCellValue(row[upstreamIndex]);
    const rawCount = row[resolvedCountIndex];
    const count =
      typeof rawCount === "number"
        ? rawCount
        : Number.parseInt(formatCellValue(rawCount), 10) || 0;
    map.set(key, count);
  }
  return map;
}

export function formatTreeChartPanelTitle(selection: TreeChartFieldSelection): string {
  if (isJunctionTableSelection(selection) && selection.junction) {
    return `${selection.tableName} · ${selection.labelField} (${selection.junction.junctionTableName})`;
  }
  return `${selection.tableName} · ${selection.labelField}`;
}
