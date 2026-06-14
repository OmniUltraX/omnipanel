import { invoke } from "@tauri-apps/api/core";
import type { SchemaFiltersSnapshot } from "./schemaFilters";

export interface DbConnectionConfig {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  group: string;
  status: string;
}

const ENGINE_DEFAULT_PORTS: Record<ConnectionFormData["engine"], number> = {
  postgresql: 5432,
  mysql: 3306,
  sqlite: 0,
  sqlserver: 1433,
  redis: 6379,
  mongodb: 27017,
};

export function normalizeConnectionGroup(group: string): string {
  if (!group.trim() || group === "default") {
    return "默认";
  }
  return group.trim();
}

export function connectionMatchesGroup(connection: DbConnectionConfig, groupName: string): boolean {
  return normalizeConnectionGroup(connection.group) === groupName;
}

export interface ConnectionFormData {
  engine: "postgresql" | "mysql" | "sqlite" | "sqlserver" | "redis" | "mongodb";
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  group: string;
}

export function formToConnection(form: ConnectionFormData, id = ""): DbConnectionConfig {
  const parsed = Number.parseInt(form.port, 10);
  const port =
    Number.isFinite(parsed) && parsed > 0 ? parsed : ENGINE_DEFAULT_PORTS[form.engine];
  return {
    id,
    name: form.name.trim() || form.host.trim() || "Untitled",
    db_type: form.engine,
    host: form.host.trim(),
    port,
    user: form.username.trim(),
    password: form.password,
    database: form.database.trim(),
    ssl: form.ssl,
    group: form.group.trim() || "默认",
    status: "unknown",
  };
}

export function connectionToForm(conn: DbConnectionConfig): ConnectionFormData {
  return {
    engine: conn.db_type as ConnectionFormData["engine"],
    name: conn.name,
    host: conn.host,
    port: String(conn.port),
    database: conn.database,
    username: conn.user,
    password: conn.password,
    ssl: conn.ssl,
    group: conn.group,
  };
}

export function isSupportedEngine(engine: ConnectionFormData["engine"]): boolean {
  return engine === "mysql" || engine === "redis";
}

export async function listConnections(): Promise<DbConnectionConfig[]> {
  return invoke<DbConnectionConfig[]>("db_list_connections");
}

export async function loadSchemaFilters(): Promise<SchemaFiltersSnapshot> {
  return invoke<SchemaFiltersSnapshot>("db_load_schema_filters");
}

export async function saveSchemaFilters(snapshot: SchemaFiltersSnapshot): Promise<void> {
  return invoke<void>("db_save_schema_filters", { snapshot });
}

export async function saveConnection(connection: DbConnectionConfig): Promise<DbConnectionConfig> {
  return invoke<DbConnectionConfig>("db_save_connection", { connection });
}

export async function testConnection(connection: DbConnectionConfig): Promise<string> {
  return invoke<string>("db_test_connection", { connection });
}

export async function listDatabases(connection: DbConnectionConfig): Promise<string[]> {
  return invoke<string[]>("db_list_databases", { connection });
}

export interface CreateDatabaseArgs {
  connection: DbConnectionConfig;
  name: string;
  charset?: string | null;
  collation?: string | null;
}

export async function createDatabase(args: CreateDatabaseArgs): Promise<string> {
  return invoke<string>("db_create_database", { args });
}

/** 常用 MySQL 字符集 + 默认排序规则，按推荐度排序。 */
export const MYSQL_CHARSET_PRESETS: { value: string; label: string; collation: string }[] = [
  { value: "utf8mb4", label: "utf8mb4 (推荐)", collation: "utf8mb4_unicode_ci" },
  { value: "utf8", label: "utf8", collation: "utf8_general_ci" },
  { value: "utf8mb4_0900_ai_ci", label: "utf8mb4_0900_ai_ci (MySQL 8 默认排序)", collation: "utf8mb4_0900_ai_ci" },
  { value: "gbk", label: "gbk", collation: "gbk_chinese_ci" },
  { value: "latin1", label: "latin1", collation: "latin1_swedish_ci" },
];

export interface DbColumnMeta {
  name: string;
  type: string;
  isPk: boolean;
  isFk: boolean;
}

export interface DbIndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface DbTableSchema {
  name: string;
  columns: DbColumnMeta[];
  indexes?: DbIndexMeta[];
}

export interface DbIntrospectResult {
  database: string;
  tables: DbTableSchema[];
}

export async function introspectSchema(
  connection: DbConnectionConfig,
  database?: string,
): Promise<DbIntrospectResult> {
  return invoke<DbIntrospectResult>("db_introspect_schema", {
    connection,
    schema: database?.trim() ? database.trim() : null,
  });
}

export async function introspectTable(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<DbTableSchema> {
  return invoke<DbTableSchema>("db_introspect_table", {
    connection,
    schema: database.trim() ? database.trim() : null,
    table,
  });
}

export async function fetchTableDdl(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<string> {
  return invoke<string>("db_table_ddl", {
    connection,
    schema: database.trim() ? database.trim() : null,
    table,
  });
}

export async function listTables(
  connection: DbConnectionConfig,
  schema?: string
): Promise<string[]> {
  return invoke<string[]>("db_list_tables", {
    connection,
    schema: schema?.trim() ? schema.trim() : null,
  });
}

export interface TablePreviewResult {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export async function previewTable(
  connection: DbConnectionConfig,
  table: string,
  limit = 200,
  offset = 0,
): Promise<TablePreviewResult> {
  return invoke<TablePreviewResult>("db_preview_table", { connection, table, limit, offset });
}

export interface TableRowCount {
  name: string;
  count: number | null;
}

export async function countTable(
  connection: DbConnectionConfig,
  table: string,
  database?: string,
): Promise<number> {
  return invoke<number>("db_count_table", {
    connection,
    table,
    schema: database?.trim() ? database.trim() : null,
  });
}

/** 单连接顺序统计多表行数（工具箱数据同步用）。 */
export async function countTables(
  connection: DbConnectionConfig,
  database: string,
  tables: string[],
): Promise<TableRowCount[]> {
  return invoke<TableRowCount[]>("db_count_tables", {
    connection,
    schema: database.trim() ? database.trim() : null,
    tables,
  });
}
