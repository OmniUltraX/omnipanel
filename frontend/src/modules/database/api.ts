import { commands } from "../../ipc/bindings";
import type {
  DbConnectionConfig as BindingsDbConnectionConfig,
  DbQueryResult,
  RedisSearchKeysResult_Serialize,
  SchemaCacheSnapshot as BindingsSchemaCacheSnapshot,
  SchemaCacheSnapshot_Deserialize,
  TableInfo,
} from "../../ipc/bindings";
import { asArray } from "../../ipc/asArray";
import { unwrapCommand } from "../../ipc/result";
import { isNameOnlyChange } from "../../lib/nameOnlyChange";
import { scheduleAssistantSnapshotSync } from "../assistant";
import { scheduleClientModuleSync, recordModuleTombstones } from "../clientSync";
import {
  defaultPortForEngine,
  getEngineWorkbench,
  isRegisteredEngine,
  resolveEngineKey,
} from "./engineRegistry";
import { isSchemaLikeTree } from "./workbench/engineWorkbench";
import { catalogFamily } from "./hostCapabilities";
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
  sid?: string;
  sysdba?: boolean;
  group: string;
  status: string;
  /** 是否启用；`false` 时连接在侧栏显示为已关闭且不可展开查询 */
  enabled?: boolean;
  /** 钥匙串中是否已保存密码（列表不返回明文） */
  has_password?: boolean;
}

/** 未显式设为 `false` 时视为启用（兼容旧配置）。 */
export function isConnectionEnabled(connection: Pick<DbConnectionConfig, "enabled">): boolean {
  return connection.enabled !== false;
}

export interface ConnectionFormData {
  engine: string;
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  sid: string;
  sysdba: boolean;
  group: string;
}

/** IPC / 旧配置可能缺字段；统一成可 trim 的字符串，避免测试连接时 TypeError。 */
function formText(value: string | null | undefined): string {
  return value ?? "";
}

export function formToConnection(form: ConnectionFormData, id = ""): DbConnectionConfig {
  const parsed = Number.parseInt(form.port, 10);
  const port =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : defaultPortForEngine(form.engine) || 0;
  let database = formText(form.database).trim();
  if ((form.engine === "qdrant" || form.engine === "clickhouse" || form.engine === "ch") && !database) {
    database = "default";
  }
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
    sid: form.engine === "oracle" || form.engine === "orcl" ? formText(form.sid).trim() : "",
    sysdba: (form.engine === "oracle" || form.engine === "orcl") && Boolean(form.sysdba),
    group: form.group.trim() || "默认",
    status: "unknown",
    enabled: true,
  };
}

export function connectionToForm(conn: DbConnectionConfig): ConnectionFormData {
  const rawType = formText(conn.db_type).toLowerCase();
  const engine = resolveEngineKey(rawType) ?? (rawType || "mysql");
  return {
    engine,
    name: formText(conn.name),
    host: formText(conn.host),
    port: String(conn.port ?? defaultPortForEngine(engine) ?? ""),
    database: formText(conn.database),
    username: formText(conn.user),
    password: formText(conn.password),
    ssl: Boolean(conn.ssl),
    sid: formText(conn.sid),
    sysdba: Boolean(conn.sysdba),
    group: conn.group || "默认",
  };
}

export function isSupportedEngine(engine: ConnectionFormData["engine"]): boolean {
  return isRegisteredEngine(engine);
}

/** Redis / MongoDB / Qdrant 等文档或 KV 引擎的「表」节点无传统字段/索引子树。 */
export function connectionHasTableSchemaChildren(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return isSchemaLikeTree(getEngineWorkbench(connection.db_type).tree);
}

/** 可在 SQL 编辑器中执行查询的连接（排除 Redis / MongoDB / Qdrant 等非 SQL 引擎）。 */
export function isSqlCapableConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return (
    getEngineWorkbench(connection.db_type).editor === "sql" ||
    getEngineWorkbench(connection.db_type).editor === "cypher" ||
    getEngineWorkbench(connection.db_type).editor === "cql"
  );
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

/** PostgreSQL 系连接（库列表 / 会话 / 参数）。 */
export function isPostgresConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return catalogFamily(connection.db_type) === "postgresLike";
}

export function isOracleLikeConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return catalogFamily(connection.db_type) === "oracleLike";
}

export function isSqlServerConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine === "sqlserver" || engine === "mssql" || engine === "sql server";
}

/** 连接信息面板是否支持该连接。 */
export function isConnectionInfoCapable(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return (
    isMysqlConnectionInfoCapable(connection) ||
    isPostgresConnectionInfoCapable(connection) ||
    isOracleLikeConnectionInfoCapable(connection) ||
    isSqlServerConnectionInfoCapable(connection)
  );
}

/** MongoDB 连接（集合预览）。 */
export function isMongoConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return getEngineWorkbench(connection.db_type).tree === "documents";
}

/** Qdrant 连接（Collection / Points 预览）。 */
export function isQdrantConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return getEngineWorkbench(connection.db_type).tree === "collections";
}

/** Redis 连接（键值查询面板）。 */
export function isRedisConnection(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return getEngineWorkbench(connection.db_type).tree === "kv";
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

function mapRedisSearchKeysResult(result: unknown): RedisSearchKeysResult {
  const payload =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as RedisSearchKeysResult_Serialize)
      : null;
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return {
    entries: entries.map((e) => ({
      key: e.key,
      keyType: e.keyType,
      value: e.value,
    })),
    nextCursor: payload?.nextCursor ?? 0,
    hasMore: Boolean(payload?.hasMore),
    scanLimitHit: Boolean(payload?.scanLimitHit),
  };
}

export async function redisConfigGet(
  connection: DbConnectionConfig,
  pattern: string,
): Promise<Array<[string, string]>> {
  return asArray(await unwrapCommand(commands.dbRedisConfigGetEntries(ipcConn(connection), pattern)));
}

function mapQueryResult(result: DbQueryResult): { columns: string[]; rows: unknown[][] } {
  return {
    columns: Array.isArray(result?.columns) ? result.columns : [],
    rows: Array.isArray(result?.rows) ? (result.rows as unknown[][]) : [],
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
  options?: { quiet?: boolean },
): Promise<RedisKeyDetail> {
  const result = await unwrapCommand(commands.dbRedisKeyDetail(ipcConn(connection), key), {
    quiet: options?.quiet,
  });
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
  const rows = asArray(await unwrapCommand(commands.dbRedisSlowlog(ipcConn(connection), count)));
  return rows.map((row) => ({
    id: row.id ?? 0,
    timestamp: row.timestamp ?? 0,
    durationUs: row.durationUs ?? 0,
    command: row.command,
    clientAddr: row.clientAddr ?? null,
    clientName: row.clientName ?? null,
  }));
}

export interface RedisInfoResult {
  sections: Record<string, Record<string, string>>;
}

export interface RedisMemoryStats {
  entries: Record<string, string>;
}

export interface RedisStreamGroup {
  name: string;
  consumers?: number | null;
  pending?: number | null;
  lag?: number | null;
  entriesRead?: number | null;
  lastDeliveredId?: string | null;
  behindSeconds?: number | null;
}

export interface RedisStreamConsumer {
  name: string;
  pending?: number | null;
  idleMs?: number | null;
  active: boolean;
}

export interface RedisStreamPendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
}

export interface RedisStreamMonitorSnapshot {
  key: string;
  newestId?: string | null;
  newestTsMs?: number | null;
  groups: RedisStreamGroup[];
  consumers: RedisStreamConsumer[];
  sampledAt: number;
}

export interface RedisStreamConsumerCleanupResult {
  removedConsumers: string[];
  claimedPending: number;
  failed: string[];
}

export interface RedisAclUser {
  username: string;
  flags: string;
  commands: string;
  keys: string;
  channels: string;
  raw: string;
}

export async function redisClientKill(
  connection: DbConnectionConfig,
  addr: string,
): Promise<number> {
  return (await unwrapCommand(commands.dbRedisClientKill(ipcConn(connection), addr))) ?? 0;
}

export async function redisInfo(
  connection: DbConnectionConfig,
  section?: string,
): Promise<RedisInfoResult> {
  const result = await unwrapCommand(commands.dbRedisInfo(ipcConn(connection), section ?? null));
  return { sections: result.sections ?? {} };
}

export async function redisMemoryStats(connection: DbConnectionConfig): Promise<RedisMemoryStats> {
  const result = await unwrapCommand(commands.dbRedisMemoryStats(ipcConn(connection)));
  return { entries: result.entries ?? {} };
}

export async function redisMemoryDoctor(connection: DbConnectionConfig): Promise<string> {
  return unwrapCommand(commands.dbRedisMemoryDoctor(ipcConn(connection)));
}

export async function redisMemoryPurge(connection: DbConnectionConfig): Promise<number> {
  return (await unwrapCommand(commands.dbRedisMemoryPurge(ipcConn(connection)))) ?? 0;
}

export async function redisConfigSet(
  connection: DbConnectionConfig,
  parameter: string,
  value: string,
): Promise<void> {
  await unwrapCommand(commands.dbRedisConfigSet(ipcConn(connection), parameter, value));
}

export async function redisConfigRewrite(connection: DbConnectionConfig): Promise<void> {
  await unwrapCommand(commands.dbRedisConfigRewrite(ipcConn(connection)));
}

export async function redisFlushDb(connection: DbConnectionConfig, async = true): Promise<void> {
  await unwrapCommand(commands.dbRedisFlushDb(ipcConn(connection), async));
}

export async function redisFlushAll(connection: DbConnectionConfig, async = true): Promise<void> {
  await unwrapCommand(commands.dbRedisFlushAll(ipcConn(connection), async));
}

export async function redisStreamMonitor(
  connection: DbConnectionConfig,
  key: string,
  group?: string,
): Promise<RedisStreamMonitorSnapshot> {
  const result = await unwrapCommand(
    commands.dbRedisStreamMonitor(ipcConn(connection), key, group ?? null),
  );
  return {
    key: result.key,
    newestId: result.newestId ?? null,
    newestTsMs: result.newestTsMs ?? null,
    groups: (result.groups ?? []).map((g) => ({
      name: g.name,
      consumers: g.consumers ?? null,
      pending: g.pending ?? null,
      lag: g.lag ?? null,
      entriesRead: g.entriesRead ?? null,
      lastDeliveredId: g.lastDeliveredId ?? null,
      behindSeconds: g.behindSeconds ?? null,
    })),
    consumers: (result.consumers ?? []).map((c) => ({
      name: c.name,
      pending: c.pending ?? null,
      idleMs: c.idleMs ?? null,
      active: c.active,
    })),
    sampledAt: result.sampledAt ?? 0,
  };
}

export async function redisStreamPending(
  connection: DbConnectionConfig,
  key: string,
  group: string,
): Promise<RedisStreamPendingEntry[]> {
  const rows = asArray(
    await unwrapCommand(
      commands.dbRedisStreamPending(ipcConn(connection), key, group, null, null, 50),
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    consumer: row.consumer,
    idleMs: row.idleMs ?? 0,
    deliveryCount: row.deliveryCount ?? 0,
  }));
}

export async function redisStreamClaim(
  connection: DbConnectionConfig,
  key: string,
  group: string,
  consumer: string,
  minIdleMs: number,
  startId: string,
  count = 10,
): Promise<number> {
  return (
    (await unwrapCommand(
      commands.dbRedisStreamClaim(
        ipcConn(connection),
        key,
        group,
        consumer,
        minIdleMs,
        startId,
        count,
      ),
    )) ?? 0
  );
}

export async function redisStreamGroupDestroy(
  connection: DbConnectionConfig,
  key: string,
  group: string,
): Promise<void> {
  await unwrapCommand(commands.dbRedisStreamGroupDestroy(ipcConn(connection), key, group));
}

export async function redisStreamTrim(
  connection: DbConnectionConfig,
  key: string,
  maxlen: number,
  approximate = true,
): Promise<number> {
  return (
    (await unwrapCommand(
      commands.dbRedisStreamTrim(ipcConn(connection), key, maxlen, approximate),
    )) ?? 0
  );
}

export async function redisStreamCleanupInactiveConsumers(
  connection: DbConnectionConfig,
  key: string,
  group: string,
  idleThresholdMs = 300_000,
  targetConsumer?: string | null,
): Promise<RedisStreamConsumerCleanupResult> {
  const result = await unwrapCommand(
    commands.dbRedisStreamCleanupInactiveConsumers(
      ipcConn(connection),
      key,
      group,
      idleThresholdMs,
      targetConsumer ?? null,
    ),
  );
  return {
    removedConsumers: result.removedConsumers ?? [],
    claimedPending: result.claimedPending ?? 0,
    failed: result.failed ?? [],
  };
}

export async function redisAclList(connection: DbConnectionConfig): Promise<RedisAclUser[]> {
  const rows = asArray(await unwrapCommand(commands.dbRedisAclList(ipcConn(connection))));
  return rows.map((row) => ({
    username: row.username,
    flags: row.flags,
    commands: row.commands,
    keys: row.keys,
    channels: row.channels,
    raw: row.raw,
  }));
}

export async function redisAclDeluser(
  connection: DbConnectionConfig,
  username: string,
): Promise<number> {
  return (await unwrapCommand(commands.dbRedisAclDeluser(ipcConn(connection), username))) ?? 0;
}

export async function redisHashSetField(
  connection: DbConnectionConfig,
  key: string,
  field: string,
  value: string,
): Promise<void> {
  await unwrapCommand(commands.dbRedisHashSetField(ipcConn(connection), key, field, value));
}

export async function redisHashDelFields(
  connection: DbConnectionConfig,
  key: string,
  fields: string[],
): Promise<number> {
  return (
    (await unwrapCommand(commands.dbRedisHashDelFields(ipcConn(connection), key, fields))) ?? 0
  );
}

export async function redisListPush(
  connection: DbConnectionConfig,
  key: string,
  side: "left" | "right",
  values: string[],
): Promise<number> {
  return (
    (await unwrapCommand(
      commands.dbRedisListPush(ipcConn(connection), key, side, values),
    )) ?? 0
  );
}

export async function redisListRemove(
  connection: DbConnectionConfig,
  key: string,
  count: number,
  value: string,
): Promise<number> {
  return (
    (await unwrapCommand(
      commands.dbRedisListRemove(ipcConn(connection), key, count, value),
    )) ?? 0
  );
}

export async function redisSetAdd(
  connection: DbConnectionConfig,
  key: string,
  members: string[],
): Promise<number> {
  return (await unwrapCommand(commands.dbRedisSetAdd(ipcConn(connection), key, members))) ?? 0;
}

export async function redisSetRemove(
  connection: DbConnectionConfig,
  key: string,
  members: string[],
): Promise<number> {
  return (await unwrapCommand(commands.dbRedisSetRemove(ipcConn(connection), key, members))) ?? 0;
}

export async function redisZsetAdd(
  connection: DbConnectionConfig,
  key: string,
  member: string,
  score: number,
): Promise<number> {
  return (
    (await unwrapCommand(commands.dbRedisZsetAdd(ipcConn(connection), key, member, score))) ?? 0
  );
}

export async function redisZsetRemove(
  connection: DbConnectionConfig,
  key: string,
  members: string[],
): Promise<number> {
  return (await unwrapCommand(commands.dbRedisZsetRemove(ipcConn(connection), key, members))) ?? 0;
}

export async function redisExpireKey(
  connection: DbConnectionConfig,
  key: string,
  seconds: number,
): Promise<boolean> {
  return unwrapCommand(commands.dbRedisExpireKey(ipcConn(connection), key, seconds));
}

/** Qdrant 按 point id 批量删除。 */
export async function qdrantDeletePoints(
  connection: DbConnectionConfig,
  collection: string,
  pointIds: unknown[],
): Promise<number> {
  return (
    (await unwrapCommand(
      commands.dbQdrantDeletePoints({
        connection: ipcConn(connection),
        collection,
        pointIds,
      }),
    )) ?? 0
  );
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
  // 名称不参与云端同步：保存前取旧值，用于判断是否纯改名（列表含禁用连接）
  let existing: BindingsDbConnectionConfig | undefined;
  try {
    const list = await unwrapCommand(commands.dbListConnections(), { quiet: true });
    existing = list.find((c) => c.id === connection.id);
  } catch {
    // 取旧值失败时保守处理：照常触发同步
  }
  const saved = (await unwrapCommand(
    commands.dbSaveConnection(ipcConn(connection)),
  )) as DbConnectionConfig;
  // 保持 AI @ 菜单等共享列表与本地落盘一致
  void import("../../stores/dbConnectionListStore").then((m) =>
    m.useDbConnectionListStore.getState().refresh(),
  );
  scheduleAssistantSnapshotSync();
  if (!isNameOnlyChange(ipcConn(connection), existing, "name")) {
    scheduleClientModuleSync();
  }
  return saved;
}

export async function deleteConnection(id: string): Promise<void> {
  await unwrapCommand(commands.dbDeleteConnection(id));
  void import("../../stores/dbConnectionListStore").then((m) =>
    m.useDbConnectionListStore.getState().refresh(),
  );
  recordModuleTombstones("database", [id]);
  scheduleAssistantSnapshotSync();
  scheduleClientModuleSync();
}

export async function testConnection(
  connection: DbConnectionConfig,
  options?: { quiet?: boolean },
): Promise<string> {
  return unwrapCommand(commands.dbTestConnection(ipcConn(connection)), {
    quiet: options?.quiet,
  });
}

export async function listDatabases(connection: DbConnectionConfig, options?: { quiet?: boolean }): Promise<string[]> {
  return asArray(
    await unwrapCommand(commands.dbListDatabases(ipcConn(connection)), {
      quiet: options?.quiet,
    }),
  );
}

export async function listDatabasesWithStats(
  connection: DbConnectionConfig,
  options?: { quiet?: boolean },
): Promise<DbDatabaseMeta[]> {
  return asArray(
    await unwrapCommand(commands.dbListDatabasesWithStats(ipcConn(connection)), {
      quiet: options?.quiet,
    }),
  );
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
  return asArray(await unwrapCommand(commands.dbListCharacterSets(ipcConn(connection))));
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
  options?: { quiet?: boolean },
): Promise<DbUserMeta[]> {
  return asArray(
    await unwrapCommand(commands.dbListConnectionUsers(ipcConn(connection)), {
      quiet: options?.quiet,
    }),
  );
}

function normalizeIntrospectResult(raw: unknown, fallbackDatabase = ""): DbIntrospectResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { database: fallbackDatabase, tables: [], views: [], routines: [] };
  }
  const result = raw as Partial<DbIntrospectResult>;
  return {
    database: result.database ?? fallbackDatabase,
    tables: asArray(result.tables),
    views: result.views == null ? undefined : asArray(result.views),
    routines: result.routines == null ? undefined : asArray(result.routines),
  };
}

export async function introspectSchema(
  connection: DbConnectionConfig,
  database?: string,
  options?: { quiet?: boolean },
): Promise<DbIntrospectResult> {
  const trimmed = database?.trim() ? database.trim() : null;
  return normalizeIntrospectResult(
    await unwrapCommand(commands.dbIntrospectSchema(ipcConn(connection), trimmed), {
      quiet: options?.quiet,
    }),
    trimmed ?? "",
  );
}

export async function introspectTable(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<DbTableSchema> {
  const raw = await unwrapCommand(
    commands.dbIntrospectTable(
      ipcConn(connection),
      database.trim() ? database.trim() : null,
      table,
    ),
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { name: table, columns: [] };
  }
  const result = raw as Partial<DbTableSchema>;
  return {
    name: result.name ?? table,
    columns: asArray(result.columns),
    indexes: result.indexes == null ? undefined : asArray(result.indexes),
    comment: result.comment ?? null,
  };
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
  return asArray(
    await unwrapCommand(
      commands.dbListTableDetails(
        ipcConn(connection),
        database.trim() ? database.trim() : null,
      ),
    ),
  );
}

export async function listTables(
  connection: DbConnectionConfig,
  schema?: string,
): Promise<string[]> {
  return asArray(
    await unwrapCommand(
      commands.dbListTables(ipcConn(connection), schema?.trim() ? schema.trim() : null),
    ),
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
