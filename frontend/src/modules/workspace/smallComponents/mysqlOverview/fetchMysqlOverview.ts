import {
  commands,
  type DbConnectionConfig as IpcDbConnectionConfig,
} from "../../../../ipc/bindings";
import { unwrapCommand } from "../../../../ipc/result";
import { makeQueryRunId } from "../../../database/sql/queryRun";
import { rowsToRecord } from "../../../database/workspace/dbWorkspaceState";
import { fetchHostDiskTotalBytes } from "../hostDiskTotal";

export type MysqlOverviewSnapshot = {
  database: string;
  datadir: string;
  innodbBufferPoolSizeBytes: number | null;
  innodbBufferPoolInstances: number | null;
  /** InnoDB 缓冲池已用字节（STATUS，部分版本无此变量） */
  innodbBufferPoolBytesData: number | null;
  innodbBufferPoolPagesData: number | null;
  innodbBufferPoolPagesTotal: number | null;
  maxConnections: number | null;
  threadsConnected: number | null;
  maxUsedConnections: number | null;
  threadCacheSize: number | null;
  threadsCached: number | null;
  /** 当前库表数据+索引占用 */
  diskBytes: number | null;
  /** datadir 所在文件系统容量（依赖匹配到的 SSH 主机磁盘统计） */
  diskTotalBytes: number | null;
  fetchedAt: number;
};

function parseNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

function mysqlQuoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** 兼容 MySQL/MariaDB 列名大小写差异（Variable_name / variable_name 等） */
function pickField(
  row: Record<string, unknown> | undefined,
  ...names: string[]
): unknown {
  if (!row) return undefined;
  const entries = Object.entries(row);
  for (const name of names) {
    const want = name.toLowerCase();
    const hit = entries.find(([k]) => k.toLowerCase() === want);
    if (hit) return hit[1];
  }
  return undefined;
}

async function queryRows(
  connection: IpcDbConnectionConfig,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const result = await unwrapCommand(
    commands.dbExecuteQuery(connection, sql, makeQueryRunId(), null, null, null),
    { quiet: true },
  );
  return rowsToRecord(result.columns, result.rows as unknown[][]);
}

function mapNameValueRows(
  rows: Record<string, unknown>[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = String(
      pickField(row, "Variable_name", "variable_name", "VARIABLE_NAME") ?? "",
    )
      .trim()
      .toLowerCase();
    if (!name) continue;
    const value = String(
      pickField(row, "Value", "value", "VALUE") ?? "",
    ).trim();
    map.set(name, value);
  }
  return map;
}

/**
 * 库磁盘占用：information_schema 在部分引擎上 table_schema 为二进制字符集，
 * 直接字符串比较可能匹配不到；列别名大小写也不稳定。
 */
async function fetchDatabaseDiskBytes(
  connection: IpcDbConnectionConfig,
  database: string,
): Promise<number | null> {
  if (!database) return null;

  const literal = mysqlQuoteLiteral(database);
  const primarySql = `
SELECT CAST(
  COALESCE(SUM(IFNULL(data_length, 0) + IFNULL(index_length, 0)), 0) AS UNSIGNED
) AS total_bytes
FROM information_schema.tables
WHERE CONVERT(table_schema USING utf8mb4) = CONVERT(${literal} USING utf8mb4)
  AND table_type = 'BASE TABLE'`.trim();

  try {
    const rows = await queryRows(connection, primarySql);
    const raw = pickField(rows[0], "total_bytes", "TOTAL_BYTES");
    const n = parseNumber(raw);
    if (n != null) return n;
  } catch {
    // 部分托管实例禁用 CONVERT / table_type，走兜底
  }

  const fallbackSql = `
SELECT
  table_schema AS db,
  SUM(IFNULL(data_length, 0) + IFNULL(index_length, 0)) AS total_bytes
FROM information_schema.tables
WHERE table_schema = ${literal}
GROUP BY table_schema`.trim();

  try {
    const rows = await queryRows(connection, fallbackSql);
    const raw = pickField(rows[0], "total_bytes", "TOTAL_BYTES");
    const n = parseNumber(raw);
    if (n != null) return n;
    if (rows.length > 0) return 0;
  } catch {
    return null;
  }

  try {
    const scanSql = `
SELECT
  CONVERT(table_schema USING utf8mb4) AS db,
  CAST(COALESCE(SUM(IFNULL(data_length, 0) + IFNULL(index_length, 0)), 0) AS UNSIGNED) AS total_bytes
FROM information_schema.tables
WHERE LOWER(CONVERT(table_schema USING utf8mb4)) = LOWER(CONVERT(${literal} USING utf8mb4))
GROUP BY CONVERT(table_schema USING utf8mb4)`.trim();
    const rows = await queryRows(connection, scanSql);
    const raw = pickField(rows[0], "total_bytes", "TOTAL_BYTES");
    const n = parseNumber(raw);
    if (n != null) return n;
    return rows.length > 0 ? 0 : null;
  } catch {
    return null;
  }
}

/** 拉取 MySQL 运行参数、状态计数与当前库磁盘占用。 */
export async function fetchMysqlOverviewSnapshot(
  connection: IpcDbConnectionConfig,
): Promise<MysqlOverviewSnapshot> {
  const database = connection.database.trim();

  const variablesSql = `
SHOW VARIABLES WHERE Variable_name IN (
  'datadir',
  'innodb_buffer_pool_size',
  'innodb_buffer_pool_instances',
  'max_connections',
  'thread_cache_size'
)`.trim();

  const statusSql = `
SHOW GLOBAL STATUS WHERE Variable_name IN (
  'Threads_connected',
  'Max_used_connections',
  'Threads_cached',
  'Innodb_buffer_pool_bytes_data',
  'Innodb_buffer_pool_pages_data',
  'Innodb_buffer_pool_pages_total'
)`.trim();

  const [variableRows, statusRows, diskBytes] = await Promise.all([
    queryRows(connection, variablesSql),
    queryRows(connection, statusSql).catch(() => [] as Record<string, unknown>[]),
    fetchDatabaseDiskBytes(connection, database),
  ]);

  const vars = mapNameValueRows(variableRows);
  const status = mapNameValueRows(statusRows);
  const readVar = (name: string) => vars.get(name.toLowerCase()) ?? "";
  const readStatus = (name: string) => status.get(name.toLowerCase()) ?? "";
  const datadir = readVar("datadir");

  const diskTotalBytes = await fetchHostDiskTotalBytes(connection.host, datadir);

  return {
    database,
    datadir,
    innodbBufferPoolSizeBytes: parseNumber(readVar("innodb_buffer_pool_size")),
    innodbBufferPoolInstances: parseNumber(
      readVar("innodb_buffer_pool_instances"),
    ),
    innodbBufferPoolBytesData: parseNumber(
      readStatus("innodb_buffer_pool_bytes_data"),
    ),
    innodbBufferPoolPagesData: parseNumber(
      readStatus("innodb_buffer_pool_pages_data"),
    ),
    innodbBufferPoolPagesTotal: parseNumber(
      readStatus("innodb_buffer_pool_pages_total"),
    ),
    maxConnections: parseNumber(readVar("max_connections")),
    threadsConnected: parseNumber(readStatus("threads_connected")),
    maxUsedConnections: parseNumber(readStatus("max_used_connections")),
    threadCacheSize: parseNumber(readVar("thread_cache_size")),
    threadsCached: parseNumber(readStatus("threads_cached")),
    diskBytes,
    diskTotalBytes,
    fetchedAt: Date.now(),
  };
}

