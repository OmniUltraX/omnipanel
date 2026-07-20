import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { optionalString, requireString } from "../../../lib/ai/mcpToolArgs";
import {
  introspectTable,
  isConnectionEnabled,
  isSqlCapableConnection,
  listConnections,
  listDatabases,
  listTables,
  type DbConnectionConfig,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import { makeQueryRunId } from "../sql/queryRun";
import type { QueryResult } from "../workspace/dbWorkspaceState";

function assertSqlIdentifier(name: string, label: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_$]+$/.test(trimmed)) {
    throw new Error(`${label} 含非法字符：${name}`);
  }
  return trimmed;
}

function filterByKeyword(items: string[], keyword?: string): string[] {
  if (!keyword) return items;
  const lower = keyword.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(lower));
}

async function resolveConnectionByName(connectionName: string): Promise<DbConnectionConfig> {
  const connections = await listConnections();
  const conn = connections.find((item) => item.name === connectionName);
  if (!conn) {
    throw new Error(`连接不存在：${connectionName}`);
  }
  if (!isConnectionEnabled(conn)) {
    throw new Error(`连接已禁用：${connectionName}`);
  }
  if (!isSqlCapableConnection(conn)) {
    throw new Error(`连接 ${connectionName} 不支持 SQL 操作`);
  }
  return conn;
}

function formatQueryResult(result: QueryResult): string {
  const payload =
    result.columns.length === 0
      ? { rowsAffected: result.rowsAffected }
      : {
          columns: result.columns,
          rows: result.rows,
          rowsAffected: result.rowsAffected,
        };

  return JSON.stringify(
    payload,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

async function getDatabasesFromConnection(
  args: Record<string, unknown>,
): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const keyword = optionalString(args, "keyword");
  const conn = await resolveConnectionByName(connectionName);
  const databases = await listDatabases(conn);
  const filtered = filterByKeyword(databases, keyword);
  return JSON.stringify({ connection: connectionName, databases: filtered }, null, 2);
}

async function getTablesFromDatabase(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = requireString(args, "database_name");
  const keyword = optionalString(args, "keyword");
  const conn = connectionWithDatabase(
    await resolveConnectionByName(connectionName),
    databaseName,
  );
  const tables = await listTables(conn, databaseName);
  const filtered = filterByKeyword(tables, keyword);
  return JSON.stringify(
    { connection: connectionName, database: databaseName, tables: filtered },
    null,
    2,
  );
}

async function getTableInfo(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = requireString(args, "database_name");
  const tableName = assertSqlIdentifier(requireString(args, "table_name"), "表名");
  const conn = connectionWithDatabase(
    await resolveConnectionByName(connectionName),
    databaseName,
  );
  const engine = conn.db_type.toLowerCase();

  if (engine === "mysql" || engine === "mariadb") {
    const sql = `DESC \`${tableName}\``;
    const result = await invoke<QueryResult>("db_execute_query", {
      connection: conn,
      sql,
      runId: makeQueryRunId(),
    });
    return formatQueryResult(result);
  }

  const schema = await introspectTable(conn, databaseName, tableName);
  return JSON.stringify(schema, null, 2);
}

async function executeSql(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = requireString(args, "database_name");
  const sql = requireString(args, "sql");
  const conn = connectionWithDatabase(
    await resolveConnectionByName(connectionName),
    databaseName,
  );
  const result = await invoke<QueryResult>("db_execute_query", {
    connection: conn,
    sql,
    runId: makeQueryRunId(),
    limit: 500,
    offset: 0,
  });
  return formatQueryResult(result);
}

/**
 * 查看数据库当前会话/进程列表。
 * - MySQL/MariaDB: SELECT * FROM information_schema.PROCESSLIST
 * - PostgreSQL: SELECT * FROM pg_stat_activity
 * - Redis: CLIENT LIST
 */
async function showProcesslist(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = optionalString(args, "database_name");
  // 复用 resolveConnectionByName 但允许 Redis（processlist 支持 Redis）
  const connections = await listConnections();
  const conn = connections.find((item) => item.name === connectionName);
  if (!conn) {
    throw new Error(`连接不存在：${connectionName}`);
  }
  if (!isConnectionEnabled(conn)) {
    throw new Error(`连接已禁用：${connectionName}`);
  }
  const engine = conn.db_type.toLowerCase();
  const withDb =
    databaseName && databaseName.trim()
      ? connectionWithDatabase(conn, databaseName)
      : conn;

  if (engine === "redis") {
    // Redis: 调用 db_redis_client_list 命令
    const result = await invoke<QueryResult>("db_redis_client_list", {
      connection: withDb,
    });
    return formatQueryResult(result);
  }

  if (!isSqlCapableConnection(conn)) {
    throw new Error(`连接 ${connectionName} 不支持 SQL 操作`);
  }

  let sql: string;
  if (engine === "mysql" || engine === "mariadb") {
    sql =
      "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO " +
      "FROM information_schema.PROCESSLIST ORDER BY TIME DESC";
  } else if (engine === "postgres" || engine === "postgresql" || engine === "pg") {
    sql =
      "SELECT pid, usename AS user_name, datname AS database, " +
      "client_addr::text AS client_addr, application_name, " +
      "backend_start, state, query_start, state_change, " +
      "wait_event_type, wait_event, query " +
      "FROM pg_stat_activity WHERE state IS NOT NULL " +
      "ORDER BY query_start DESC NULLS LAST";
  } else {
    throw new Error(`暂不支持 ${engine} 的 show_processlist`);
  }

  const result = await invoke<QueryResult>("db_execute_query", {
    connection: withDb,
    sql,
    runId: makeQueryRunId(),
    limit: 500,
    offset: 0,
  });
  return formatQueryResult(result);
}

/**
 * 终止指定会话/查询。危险操作。
 * - MySQL/MariaDB: KILL <id>
 * - PostgreSQL: SELECT pg_terminate_backend(<pid>)
 * - Redis: CLIENT KILL ADDR <ip:port>
 */
async function killQuery(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const queryId = requireString(args, "query_id");
  const connections = await listConnections();
  const conn = connections.find((item) => item.name === connectionName);
  if (!conn) {
    throw new Error(`连接不存在：${connectionName}`);
  }
  if (!isConnectionEnabled(conn)) {
    throw new Error(`连接已禁用：${connectionName}`);
  }
  const engine = conn.db_type.toLowerCase();

  if (engine === "redis") {
    // Redis: 调用 db_redis_client_kill 命令
    const killed = await invoke<number>("db_redis_client_kill", {
      connection: conn,
      addr: queryId,
    });
    return JSON.stringify(
      {
        connection: connectionName,
        query_id: queryId,
        killed,
        message:
          killed > 0 ? "CLIENT KILL 成功" : "未找到匹配的客户端（可能已断开）",
      },
      null,
      2,
    );
  }

  if (!isSqlCapableConnection(conn)) {
    throw new Error(`连接 ${connectionName} 不支持 SQL 操作`);
  }

  if (engine === "mysql" || engine === "mariadb") {
    const id = Number.parseInt(queryId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`MySQL/MariaDB query_id 必须是正整数（PROCESSLIST_ID）：${queryId}`);
    }
    const sql = `KILL ${id}`;
    const result = await invoke<QueryResult>("db_execute_query", {
      connection: conn,
      sql,
      runId: makeQueryRunId(),
    });
    return JSON.stringify(
      {
        connection: connectionName,
        query_id: queryId,
        rowsAffected: result.rowsAffected,
        message: "已发送 KILL 命令",
      },
      null,
      2,
    );
  }

  if (engine === "postgres" || engine === "postgresql" || engine === "pg") {
    const pid = Number.parseInt(queryId, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`PostgreSQL query_id 必须是正整数（pid）：${queryId}`);
    }
    const sql = `SELECT pg_terminate_backend(${pid}) AS terminated`;
    const result = await invoke<QueryResult>("db_execute_query", {
      connection: conn,
      sql,
      runId: makeQueryRunId(),
    });
    return JSON.stringify(
      {
        connection: connectionName,
        query_id: queryId,
        result: JSON.parse(formatQueryResult(result)),
      },
      null,
      2,
    );
  }

  throw new Error(`暂不支持 ${engine} 的 kill_query`);
}

/**
 * 汇总慢查询日志。
 * - MySQL/MariaDB: performance_schema.events_statements_summary_by_digest 或 mysql.slow_log
 * - PostgreSQL: pg_stat_statements
 * - Redis: SLOWLOG GET <count>
 */
async function slowLogSummary(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = optionalString(args, "database_name");
  const countRaw = args.count;
  const count =
    typeof countRaw === "number" && Number.isFinite(countRaw)
      ? Math.max(1, Math.min(100, Math.floor(countRaw)))
      : 10;
  const connections = await listConnections();
  const conn = connections.find((item) => item.name === connectionName);
  if (!conn) {
    throw new Error(`连接不存在：${connectionName}`);
  }
  if (!isConnectionEnabled(conn)) {
    throw new Error(`连接已禁用：${connectionName}`);
  }
  const engine = conn.db_type.toLowerCase();
  const withDb =
    databaseName && databaseName.trim()
      ? connectionWithDatabase(conn, databaseName)
      : conn;

  if (engine === "redis") {
    const entries = await invoke<Array<unknown>>("db_redis_slowlog", {
      connection: withDb,
      count,
    });
    return JSON.stringify(
      {
        connection: connectionName,
        source: "SLOWLOG GET",
        entries,
      },
      null,
      2,
    );
  }

  if (!isSqlCapableConnection(conn)) {
    throw new Error(`连接 ${connectionName} 不支持 SQL 操作`);
  }

  let sql: string;
  if (engine === "mysql" || engine === "mariadb") {
    sql =
      "SELECT SCHEMA_NAME AS db, DIGEST_TEXT AS query, " +
      "COUNT_STAR AS exec_count, " +
      "ROUND(SUM_TIMER_WAIT/1000000000000, 3) AS total_sec, " +
      "ROUND(AVG_TIMER_WAIT/1000000000, 3) AS avg_ms, " +
      "SUM_ROWS_EXAMINED AS rows_examined, " +
      "SUM_ROWS_SENT AS rows_sent, " +
      "FIRST_SEEN, LAST_SEEN " +
      "FROM performance_schema.events_statements_summary_by_digest " +
      "WHERE SCHEMA_NAME IS NOT NULL " +
      `ORDER BY AVG_TIMER_WAIT DESC LIMIT ${count}`;
  } else if (engine === "postgres" || engine === "postgresql" || engine === "pg") {
    sql =
      "SELECT query, calls, round(total_exec_time::numeric, 3) AS total_ms, " +
      "round(mean_exec_time::numeric, 3) AS mean_ms, " +
      "rows, shared_blks_hit, shared_blks_read, shared_blks_written " +
      "FROM pg_stat_statements " +
      `ORDER BY mean_exec_time DESC LIMIT ${count}`;
  } else {
    throw new Error(`暂不支持 ${engine} 的 slow_log_summary`);
  }

  try {
    const result = await invoke<QueryResult>("db_execute_query", {
      connection: withDb,
      sql,
      runId: makeQueryRunId(),
      limit: 500,
      offset: 0,
    });

    // MySQL performance_schema 没数据时降级到 mysql.slow_log
    if (
      (engine === "mysql" || engine === "mariadb") &&
      result.rows.length === 0
    ) {
      const fallbackSql =
        "SELECT start_time, user_host, query_time, lock_time, " +
        "rows_sent, rows_examined, sql_text " +
        `FROM mysql.slow_log ORDER BY start_time DESC LIMIT ${count}`;
      try {
        const fallbackResult = await invoke<QueryResult>("db_execute_query", {
          connection: withDb,
          sql: fallbackSql,
          runId: makeQueryRunId(),
          limit: 500,
          offset: 0,
        });
        return JSON.stringify(
          {
            connection: connectionName,
            source: "mysql.slow_log",
            result: JSON.parse(formatQueryResult(fallbackResult)),
          },
          null,
          2,
        );
      } catch {
        // 降级失败，返回原结果（空）
      }
    }

    return formatQueryResult(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (engine === "postgres" && msg.toLowerCase().includes("pg_stat_statements")) {
      throw new Error(
        `pg_stat_statements 扩展未启用：${msg}。请在目标库执行 \`CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\` 并在 postgresql.conf 添加 \`shared_preload_libraries = 'pg_stat_statements'\``,
      );
    }
    if (
      (engine === "mysql" || engine === "mariadb") &&
      (msg.toLowerCase().includes("doesn't exist") ||
        msg.toLowerCase().includes("unknown table"))
    ) {
      throw new Error(
        `性能 schema 不可用：${msg}。请检查 performance_schema 是否启用，或开启 slow_query_log + log_output=TABLE 后用 mysql.slow_log`,
      );
    }
    throw e;
  }
}

const connectionNameSchema = {
  type: "string",
  description: "数据库连接名称（与侧栏连接名一致）",
};

const databaseNameSchema = {
  type: "string",
  description: "数据库名",
};

const keywordSchema = {
  type: "string",
  description: "可选，用于过滤结果的关键字（模糊匹配，忽略大小写）",
};

/** 数据库模块向 AI 注册的 MCP 工具（omni_{module}_{function_name}） */
export const DATABASE_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_database_get_databases_from_connection",
    description: "根据连接名获取该连接下的数据库列表，可选关键字过滤。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        keyword: keywordSchema,
      },
      required: ["connection_name"],
    },
    handler: getDatabasesFromConnection,
  },
  {
    name: "omni_database_get_tables_from_database",
    description: "根据连接名和数据库名获取表列表，可选关键字过滤。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: databaseNameSchema,
        keyword: keywordSchema,
      },
      required: ["connection_name", "database_name"],
    },
    handler: getTablesFromDatabase,
  },
  {
    name: "omni_database_get_table_info",
    description:
      "根据连接名、数据库名和表名获取表结构信息（MySQL/MariaDB 执行 DESC，其他引擎使用 introspect）。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: databaseNameSchema,
        table_name: {
          type: "string",
          description: "表名",
        },
      },
      required: ["connection_name", "database_name", "table_name"],
    },
    handler: getTableInfo,
  },
  {
    name: "omni_database_execute_sql",
    description:
      "在指定连接和数据库上执行 SQL。SELECT 结果最多返回 500 行；DML 返回影响行数。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: databaseNameSchema,
        sql: {
          type: "string",
          description: "要执行的 SQL 语句",
        },
      },
      required: ["connection_name", "database_name", "sql"],
    },
    handler: executeSql,
  },
  {
    name: "omni_database_show_processlist",
    description:
      "查看数据库当前会话/进程列表（MySQL/MariaDB 查 information_schema.PROCESSLIST；PostgreSQL 查 pg_stat_activity；Redis 执行 CLIENT LIST），用于排查长运行查询、锁等待。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: {
          type: "string",
          description:
            "可选，指定数据库上下文（部分引擎需要切换到对应库才能查询元数据视图）",
        },
      },
      required: ["connection_name"],
    },
    handler: showProcesslist,
  },
  {
    name: "omni_database_kill_query",
    description:
      "终止指定会话/查询（MySQL/MariaDB 执行 KILL；PostgreSQL 调用 pg_terminate_backend；Redis 执行 CLIENT KILL ADDR）。危险操作，请确认 query_id 正确。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        query_id: {
          type: "string",
          description:
            "要终止的会话/查询 ID（MySQL/MariaDB 为 PROCESSLIST_ID 数字，PostgreSQL 为 pid 数字，Redis 为客户端地址 ip:port）",
        },
      },
      required: ["connection_name", "query_id"],
    },
    handler: killQuery,
  },
  {
    name: "omni_database_slow_log_summary",
    description:
      "汇总慢查询日志（MySQL/MariaDB 查 mysql.slow_log 或 performance_schema；PostgreSQL 查 pg_stat_statements；Redis 执行 SLOWLOG GET），用于性能优化分析。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: {
          type: "string",
          description: "可选，指定数据库上下文",
        },
        count: {
          type: "integer",
          description: "返回的记录数量上限，默认 10，范围 1~100",
          default: 10,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["connection_name"],
    },
    handler: slowLogSummary,
  },
];
