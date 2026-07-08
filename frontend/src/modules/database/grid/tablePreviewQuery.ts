import { invoke } from "@tauri-apps/api/core";
import type { RuleGroupType } from "react-querybuilder";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import {
  countTable,
  previewTable,
  type DbColumnMeta,
  type DbConnectionConfig,
  type TablePreviewResult,
} from "../api";
import { introspectToTableSchemas } from "../sqlEditor/language/completionItems";
import { makeQueryRunId } from "../sql/queryRun";
import type { TableSchema } from "../types";
import type { QueryResult, SortState } from "../workspace/dbWorkspaceState";
import { buildOrderByClause, rowsToRecord } from "../workspace/dbWorkspaceState";
import type { TableColumnRelation } from "./tableColumnRelation";
import {
  buildTablePreviewCountSqlWithRelations,
  buildTablePreviewDataSqlWithRelations,
  formatFilterWhere,
  shouldUseRelationJoinPreview,
} from "./tablePreviewFilter";

export function resolveRelationTablesFromCache(
  connId: string,
  dbName: string,
): TableSchema[] {
  const snapshot = useDbSchemaCacheStore.getState().snapshot;
  const dbEntry = snapshot.connections[connId]?.databases.find((entry) => entry.name === dbName);
  if (!dbEntry) return [];
  return introspectToTableSchemas(dbEntry.tables, "table");
}

export interface FetchTablePreviewPageParams {
  connection: DbConnectionConfig;
  connId: string;
  tableName: string;
  dbName: string;
  page: number;
  pageSize: number;
  sort?: SortState | null;
  filter?: RuleGroupType | null;
  columnMeta?: DbColumnMeta[];
  columnRelations?: Record<string, TableColumnRelation>;
  relationTables?: TableSchema[];
  /** 翻页时跳过 COUNT，仅拉取当前页数据 */
  skipCount?: boolean;
}

async function executeScalarCount(
  connection: DbConnectionConfig,
  sql: string,
): Promise<number> {
  const result = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql,
    runId: makeQueryRunId(),
    limit: null,
    offset: null,
  });
  if (result.rows.length === 0) return 0;
  const raw = result.rows[0][0];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "bigint") return Number(raw);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function executePreviewQuery(
  connection: DbConnectionConfig,
  sql: string,
  tableName: string,
): Promise<TablePreviewResult> {
  const result = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql,
    runId: makeQueryRunId(),
    limit: null,
    offset: null,
  });
  return {
    name: tableName,
    columns: result.columns,
    rows: rowsToRecord(result.columns, result.rows),
  };
}

export async function fetchTablePreviewPage({
  connection,
  connId,
  tableName,
  dbName,
  page,
  pageSize,
  sort,
  filter,
  columnMeta,
  columnRelations = {},
  relationTables,
  skipCount = false,
}: FetchTablePreviewPageParams): Promise<{ data: TablePreviewResult; totalRows?: number }> {
  const connForSchema = { ...connection, database: dbName };
  const relations = columnRelations ?? {};
  const tables = relationTables ?? resolveRelationTablesFromCache(connId, dbName);
  const dbType = connection.db_type;

  if (shouldUseRelationJoinPreview(relations, filter, sort)) {
    const sqlContext = {
      dbType,
      tableName,
      filter,
      sort,
      page,
      pageSize,
      columnRelations: relations,
      relationTables: tables,
      columnMeta,
    };
    const dataSql = buildTablePreviewDataSqlWithRelations(sqlContext);
    if (skipCount) {
      const data = await executePreviewQuery(connForSchema, dataSql, tableName);
      return { data };
    }
    const countSql = buildTablePreviewCountSqlWithRelations(sqlContext);
    const [totalRows, data] = await Promise.all([
      executeScalarCount(connForSchema, countSql),
      executePreviewQuery(connForSchema, dataSql, tableName),
    ]);
    return { data, totalRows };
  }

  const orderBy = sort ? buildOrderByClause(sort, dbType) : undefined;
  const where = formatFilterWhere(filter, dbType, columnMeta);
  const dataPromise = previewTable(
    connForSchema,
    tableName,
    pageSize,
    page * pageSize,
    orderBy,
    where,
  );
  if (skipCount) {
    const data = await dataPromise;
    return { data };
  }
  const [totalRows, data] = await Promise.all([
    countTable(connForSchema, tableName, dbName, where),
    dataPromise,
  ]);
  return { data, totalRows };
}
