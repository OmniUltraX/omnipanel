import { invoke } from "@tauri-apps/api/core";
import type { SchemaFiltersSnapshot } from "./schemaFilters";
import type { SchemaTreeExpandedSnapshot } from "./schemaTreeExpanded";
import type { SchemaCacheSnapshot } from "./schemaCache";

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
  /** 是否启用；`false` 时连接在侧栏显示为已关闭且不可展开查询 */
  enabled?: boolean;
}

/** 未显式设为 `false` 时视为启用（兼容旧配置）。 */
export function isConnectionEnabled(connection: Pick<DbConnectionConfig, "enabled">): boolean {
  return connection.enabled !== false;
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
    enabled: true,
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

/** Redis 等 KV 引擎的「表」节点无字段/索引子树。 */
export function connectionHasTableSchemaChildren(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return connection.db_type !== "redis";
}

/** 可在 SQL 编辑器中执行查询的连接（排除 Redis 等 KV 引擎）。 */
export function isSqlCapableConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return connection.db_type !== "redis";
}

/** 数据传输工具箱支持的连接（关系型库；排除 Redis / MongoDB 等）。 */
export function isToolboxCapableConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return (
    engine === "mysql" ||
    engine === "mariadb" ||
    engine === "postgresql" ||
    engine === "postgres" ||
    engine === "sqlite"
  );
}

/** 连接信息面板支持的连接（MySQL / MariaDB 专有 STATUS / PROCESSLIST）。 */
export function isMysqlConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine === "mysql" || engine === "mariadb";
}

/** Redis 连接（键值查询面板）。 */
export function isRedisConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return connection.db_type.toLowerCase() === "redis";
}

export interface RedisKeyEntry {
  key: string;
  keyType: string;
  value: string;
}

export interface RedisSearchKeysArgs {
  connection: DbConnectionConfig;
  pattern: string;
  types: string[];
  limit?: number;
}

export async function redisSearchKeys(args: RedisSearchKeysArgs): Promise<RedisKeyEntry[]> {
  return invoke<RedisKeyEntry[]>("db_redis_search_keys", {
    args: {
      connection: args.connection,
      pattern: args.pattern,
      types: args.types,
      limit: args.limit ?? 500,
    },
  });
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

export async function loadSchemaTreeExpanded(): Promise<SchemaTreeExpandedSnapshot> {
  return invoke<SchemaTreeExpandedSnapshot>("db_load_schema_tree_expanded");
}

export async function saveSchemaTreeExpanded(snapshot: SchemaTreeExpandedSnapshot): Promise<void> {
  return invoke<void>("db_save_schema_tree_expanded", { snapshot });
}

export async function loadSchemaCache(): Promise<SchemaCacheSnapshot> {
  return invoke<SchemaCacheSnapshot>("db_load_schema_cache");
}

export async function saveSchemaCache(snapshot: SchemaCacheSnapshot): Promise<void> {
  return invoke<void>("db_save_schema_cache", { snapshot });
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
  nullable?: boolean;
  comment?: string | null;
}

export interface DbIndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface DbRoutineMeta {
  name: string;
  routineType: string;
}

export interface DbUserMeta {
  name: string;
  host?: string | null;
}

export interface DbTableSchema {
  name: string;
  columns: DbColumnMeta[];
  indexes?: DbIndexMeta[];
  comment?: string | null;
}

export interface DbIntrospectResult {
  database: string;
  tables: DbTableSchema[];
  views?: DbTableSchema[];
  routines?: DbRoutineMeta[];
}

export async function listConnectionUsers(
  connection: DbConnectionConfig,
): Promise<DbUserMeta[]> {
  return invoke<DbUserMeta[]>("db_list_connection_users", { connection });
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
  orderBy?: string,
  whereClause?: string,
): Promise<TablePreviewResult> {
  return invoke<TablePreviewResult>("db_preview_table", {
    connection,
    table,
    limit,
    offset,
    orderBy,
    whereClause: whereClause?.trim() ? whereClause.trim() : null,
  });
}

export interface TableRowCount {
  name: string;
  count: number | null;
}

export async function countTable(
  connection: DbConnectionConfig,
  table: string,
  database?: string,
  whereClause?: string,
): Promise<number> {
  return invoke<number>("db_count_table", {
    connection,
    table,
    schema: database?.trim() ? database.trim() : null,
    whereClause: whereClause?.trim() ? whereClause.trim() : null,
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
