import { commands } from "../../ipc/bindings";
import type {
  DbConnectionConfig as BindingsDbConnectionConfig,
  DbQueryResult,
  RedisSearchKeysResult_Serialize,
  SchemaCacheSnapshot as BindingsSchemaCacheSnapshot,
  SchemaCacheSnapshot_Deserialize,
  TableInfo,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import type { SchemaFiltersSnapshot } from "./schema/schemaFilters";
import type { SchemaTreeExpandedSnapshot } from "./schema/schemaTreeExpanded";

/** 业务 IPC：走 commands.* + unwrapCommand，勿再写裸 invoke。 */
function ipcConn(connection: DbConnectionConfig): BindingsDbConnectionConfig {
  return connection as BindingsDbConnectionConfig;
}

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

export function normalizeConnectionGroup(group: string | null | undefined): string {
  if (!group || !group.trim() || group === "default") {
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

/** IPC / 旧配置可能缺字段；统一成可 trim 的字符串，避免测试连接时 TypeError。 */
function formText(value: string | null | undefined): string {
  return value ?? "";
}

export function formToConnection(form: ConnectionFormData, id = ""): DbConnectionConfig {
  const parsed = Number.parseInt(form.port, 10);
  const port =
    Number.isFinite(parsed) && parsed > 0 ? parsed : ENGINE_DEFAULT_PORTS[form.engine];
  const database = formText(form.database).trim();
  const host = formText(form.host).trim();
  const nameFromPath =
    form.engine === "sqlite" && database
      ? (database.split(/[/\\]/).pop() ?? database)
      : "";
  return {
    id,
    name: formText(form.name).trim() || nameFromPath || host || "Untitled",
    db_type: form.engine,
    host,
    port,
    user: formText(form.username).trim(),
    password: formText(form.password),
    database,
    ssl: Boolean(form.ssl),
    group: normalizeConnectionGroup(form.group),
    status: "unknown",
    enabled: true,
  };
}

export function connectionToForm(conn: DbConnectionConfig): ConnectionFormData {
  const rawType = formText(conn.db_type).toLowerCase();
  let engine: ConnectionFormData["engine"];
  if (rawType === "sqlite3") {
    engine = "sqlite";
  } else if (rawType === "mongo") {
    engine = "mongodb";
  } else if (rawType === "mariadb") {
    engine = "mysql";
  } else if (rawType === "postgres" || rawType === "pg") {
    engine = "postgresql";
  } else if (rawType === "mssql" || rawType === "sql server") {
    engine = "sqlserver";
  } else if (rawType in ENGINE_DEFAULT_PORTS) {
    engine = rawType as ConnectionFormData["engine"];
  } else {
    engine = "mysql";
  }
  return {
    engine,
    name: formText(conn.name),
    host: formText(conn.host),
    port: String(conn.port ?? ENGINE_DEFAULT_PORTS[engine] ?? ""),
    database: formText(conn.database),
    username: formText(conn.user),
    password: formText(conn.password),
    ssl: Boolean(conn.ssl),
    // 后端 connections.json 暂无 group 字段，编辑回显时需兜底
    group: normalizeConnectionGroup(conn.group),
  };
}

export function isSupportedEngine(engine: ConnectionFormData["engine"]): boolean {
  return (
    engine === "mysql" ||
    engine === "postgresql" ||
    engine === "sqlite" ||
    engine === "redis" ||
    engine === "mongodb"
  );
}

/** Redis / MongoDB 等文档或 KV 引擎的「表」节点无传统字段/索引子树。 */
export function connectionHasTableSchemaChildren(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine !== "redis" && engine !== "mongodb" && engine !== "mongo";
}

/** 可在 SQL 编辑器中执行查询的连接（排除 Redis / MongoDB 等非 SQL 引擎）。 */
export function isSqlCapableConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine !== "redis" && engine !== "mongodb" && engine !== "mongo";
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

/** PostgreSQL 连接（连接信息面板支持：库列表 / pg_stat_activity / pg_settings / psql）。 */
export function isPostgresConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine === "postgresql" || engine === "postgres";
}

/** 连接信息面板是否支持该连接（MySQL/MariaDB 或 PostgreSQL）。 */
export function isConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return (
    isMysqlConnectionInfoCapable(connection) ||
    isPostgresConnectionInfoCapable(connection)
  );
}

/** MongoDB 连接（集合预览）。 */
export function isMongoConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine === "mongodb" || engine === "mongo";
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
  cursor?: number;
  includeValuePreview?: boolean;
}

export interface RedisSearchKeysResult {
  entries: RedisKeyEntry[];
  nextCursor: number;
  hasMore: boolean;
  scanLimitHit?: boolean;
}

export async function redisSearchKeys(args: RedisSearchKeysArgs): Promise<RedisSearchKeysResult> {
  const result = await unwrapCommand(
    commands.dbRedisSearchKeys({
      connection: ipcConn(args.connection),
      pattern: args.pattern,
      types: args.types,
      limit: args.limit ?? 500,
      cursor: args.cursor ?? 0,
      includeValuePreview: args.includeValuePreview ?? false,
    }),
  );
  return mapRedisSearchKeysResult(result);
}

function mapRedisSearchKeysResult(result: RedisSearchKeysResult_Serialize): RedisSearchKeysResult {
  return {
    entries: result.entries.map((e) => ({
      key: e.key,
      keyType: e.keyType,
      value: e.value,
    })),
    nextCursor: result.nextCursor ?? 0,
    hasMore: result.hasMore,
    scanLimitHit: result.scanLimitHit,
  };
}

export async function redisConfigGet(
  connection: DbConnectionConfig,
  pattern: string,
): Promise<Array<[string, string]>> {
  return unwrapCommand(commands.dbRedisConfigGetEntries(ipcConn(connection), pattern));
}

function mapQueryResult(result: DbQueryResult): { columns: string[]; rows: unknown[][] } {
  return {
    columns: result.columns,
    rows: result.rows as unknown[][],
  };
}

export async function redisGetConfigAll(connection: DbConnectionConfig): Promise<{
  columns: string[];
  rows: unknown[][];
}> {
  return mapQueryResult(await unwrapCommand(commands.dbRedisConfigGet(ipcConn(connection))));
}

export async function redisGetClientList(connection: DbConnectionConfig): Promise<{
  columns: string[];
  rows: unknown[][];
}> {
  return mapQueryResult(await unwrapCommand(commands.dbRedisClientList(ipcConn(connection))));
}

export interface RedisKeyDetail {
  key: string;
  keyType: string;
  ttl: number;
  sizeBytes: number | null;
  valueJson: string;
  valueTruncated: boolean;
}

export interface RedisSlowLogEntry {
  id: number;
  timestamp: number;
  durationUs: number;
  command: string;
  clientAddr: string | null;
  clientName: string | null;
}

export async function redisDbsize(connection: DbConnectionConfig): Promise<number> {
  const size = await unwrapCommand(commands.dbRedisDbsize(ipcConn(connection)));
  return size ?? 0;
}

export async function redisKeyDetail(
  connection: DbConnectionConfig,
  key: string,
): Promise<RedisKeyDetail> {
  const result = await unwrapCommand(commands.dbRedisKeyDetail(ipcConn(connection), key));
  return {
    key: result.key,
    keyType: result.keyType,
    ttl: result.ttl ?? -1,
    sizeBytes: result.sizeBytes ?? null,
    valueJson: result.valueJson,
    valueTruncated: result.valueTruncated,
  };
}

export async function redisSetKey(
  connection: DbConnectionConfig,
  key: string,
  value: string,
  keyType = "string",
): Promise<void> {
  await unwrapCommand(commands.dbRedisSetKey(ipcConn(connection), key, value, keyType));
}

export async function redisDeleteKey(
  connection: DbConnectionConfig,
  key: string,
): Promise<number> {
  return (await unwrapCommand(commands.dbRedisDeleteKey(ipcConn(connection), key))) ?? 0;
}

export async function redisSlowlog(
  connection: DbConnectionConfig,
  count = 64,
): Promise<RedisSlowLogEntry[]> {
  const rows = await unwrapCommand(commands.dbRedisSlowlog(ipcConn(connection), count));
  return rows.map((row) => ({
    id: row.id ?? 0,
    timestamp: row.timestamp ?? 0,
    durationUs: row.durationUs ?? 0,
    command: row.command,
    clientAddr: row.clientAddr ?? null,
    clientName: row.clientName ?? null,
  }));
}

export async function listConnections(): Promise<DbConnectionConfig[]> {
  return (await unwrapCommand(commands.dbListConnections())) as DbConnectionConfig[];
}

export async function loadSchemaFilters(): Promise<SchemaFiltersSnapshot> {
  return (await unwrapCommand(commands.dbLoadSchemaFilters())) as SchemaFiltersSnapshot;
}

export async function saveSchemaFilters(snapshot: SchemaFiltersSnapshot): Promise<void> {
  await unwrapCommand(commands.dbSaveSchemaFilters(snapshot));
}

export async function loadSchemaTreeExpanded(): Promise<SchemaTreeExpandedSnapshot> {
  return (await unwrapCommand(commands.dbLoadSchemaTreeExpanded())) as SchemaTreeExpandedSnapshot;
}

export async function saveSchemaTreeExpanded(snapshot: SchemaTreeExpandedSnapshot): Promise<void> {
  await unwrapCommand(commands.dbSaveSchemaTreeExpanded(snapshot));
}

export async function loadSchemaCache(): Promise<BindingsSchemaCacheSnapshot> {
  return unwrapCommand(commands.dbLoadSchemaCache());
}

export async function saveSchemaCache(snapshot: BindingsSchemaCacheSnapshot): Promise<void> {
  await unwrapCommand(
    commands.dbSaveSchemaCache(snapshot as SchemaCacheSnapshot_Deserialize),
  );
}

/** 增量写入单连接 Schema 缓存（后端 merge + 写盘）。 */
export async function patchSchemaCache(
  connectionId: string,
  entry: NonNullable<SchemaCacheSnapshot_Deserialize["connections"]>[string],
): Promise<void> {
  await unwrapCommand(commands.dbPatchSchemaCache(connectionId, entry));
}

export async function saveConnection(connection: DbConnectionConfig): Promise<DbConnectionConfig> {
  return (await unwrapCommand(commands.dbSaveConnection(ipcConn(connection)))) as DbConnectionConfig;
}

export async function deleteConnection(id: string): Promise<void> {
  await unwrapCommand(commands.dbDeleteConnection(id));
}

export async function testConnection(connection: DbConnectionConfig): Promise<string> {
  return unwrapCommand(commands.dbTestConnection(ipcConn(connection)));
}

export async function listDatabases(connection: DbConnectionConfig): Promise<string[]> {
  return unwrapCommand(commands.dbListDatabases(ipcConn(connection)));
}

export async function listDatabasesWithStats(
  connection: DbConnectionConfig,
): Promise<DbDatabaseMeta[]> {
  return unwrapCommand(commands.dbListDatabasesWithStats(ipcConn(connection)));
}

export interface CreateDatabaseArgs {
  connection: DbConnectionConfig;
  name: string;
  charset?: string | null;
  collation?: string | null;
}

export async function createDatabase(args: CreateDatabaseArgs): Promise<string> {
  return unwrapCommand(
    commands.dbCreateDatabase({
      connection: ipcConn(args.connection),
      name: args.name,
      charset: args.charset ?? null,
      collation: args.collation ?? null,
    }),
  );
}

export interface DbCharsetMeta {
  charset: string;
  description: string;
  defaultCollation: string;
}

export interface DbDatabaseMeta {
  name: string;
  charset: string | null;
  collation: string | null;
  tableCount: number | null;
  sizeBytes: number | null;
  rowsEstimate: number | null;
}

export async function listCharacterSets(
  connection: DbConnectionConfig,
): Promise<DbCharsetMeta[]> {
  return unwrapCommand(commands.dbListCharacterSets(ipcConn(connection)));
}

export interface DbColumnMeta {
  name: string;
  type: string;
  isPk: boolean;
  isFk: boolean;
  nullable?: boolean;
  comment?: string | null;
  /** 是否为自增列（来自 schema 反射；缺省时由类型串推断） */
  isAutoIncrement?: boolean;
  /** 字符长度 / 数值精度（来自 information_schema；无长度类型为 null） */
  length?: number | null;
  /** 归一化后的默认值字面量（已去外层引号 / 类型标注；NULL 为 null） */
  defaultValue?: string | null;
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
  canLogin?: boolean;
  isSuperuser?: boolean;
  canCreateDb?: boolean;
  isRole?: boolean;
  accountLocked?: boolean | null;
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
  return unwrapCommand(commands.dbListConnectionUsers(ipcConn(connection)));
}

export async function introspectSchema(
  connection: DbConnectionConfig,
  database?: string,
): Promise<DbIntrospectResult> {
  return unwrapCommand(
    commands.dbIntrospectSchema(ipcConn(connection), database?.trim() ? database.trim() : null),
  );
}

export async function introspectTable(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<DbTableSchema> {
  return unwrapCommand(
    commands.dbIntrospectTable(
      ipcConn(connection),
      database.trim() ? database.trim() : null,
      table,
    ),
  );
}

export async function fetchTableDdl(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<string> {
  return unwrapCommand(
    commands.dbTableDdl(ipcConn(connection), database.trim() ? database.trim() : null, table),
  );
}

export interface DbTableDetails {
  rowCount?: number | null;
  dataLength?: number | null;
  rowFormat?: string | null;
  engine?: string | null;
  createTime?: string | null;
  updateTime?: string | null;
  comment?: string | null;
  collation?: string | null;
}

export async function fetchTableDetails(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<DbTableDetails> {
  return unwrapCommand(
    commands.dbGetTableDetails(
      ipcConn(connection),
      database.trim() ? database.trim() : null,
      table,
    ),
  );
}

export interface DbNamedTableDetails {
  name: string;
  details: DbTableDetails;
}

/** 一次拉取库内全部表详情（表列表首屏）。 */
export async function fetchDatabaseTableDetails(
  connection: DbConnectionConfig,
  database: string,
): Promise<DbNamedTableDetails[]> {
  return unwrapCommand(
    commands.dbListTableDetails(
      ipcConn(connection),
      database.trim() ? database.trim() : null,
    ),
  );
}

export async function listTables(
  connection: DbConnectionConfig,
  schema?: string,
): Promise<string[]> {
  return unwrapCommand(
    commands.dbListTables(ipcConn(connection), schema?.trim() ? schema.trim() : null),
  );
}

export interface TablePreviewResult {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

function mapTablePreview(info: TableInfo): TablePreviewResult {
  return {
    name: info.name,
    columns: info.columns,
    rows: info.rows as Record<string, unknown>[],
  };
}

export async function previewTable(
  connection: DbConnectionConfig,
  table: string,
  limit = 200,
  offset = 0,
  orderBy?: string,
  whereClause?: string,
): Promise<TablePreviewResult> {
  return mapTablePreview(
    await unwrapCommand(
      commands.dbPreviewTable(
        ipcConn(connection),
        table,
        limit,
        offset,
        orderBy ?? null,
        whereClause?.trim() ? whereClause.trim() : null,
      ),
    ),
  );
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
  const count = await unwrapCommand(
    commands.dbCountTable(
      ipcConn(connection),
      database?.trim() ? database.trim() : null,
      table,
      whereClause?.trim() ? whereClause.trim() : null,
    ),
  );
  return count ?? 0;
}

/** 单连接顺序统计多表行数（工具箱数据同步用）。 */
export async function countTables(
  connection: DbConnectionConfig,
  database: string,
  tables: string[],
): Promise<TableRowCount[]> {
  return unwrapCommand(
    commands.dbCountTables(
      ipcConn(connection),
      database.trim() ? database.trim() : null,
      tables,
    ),
  );
}
