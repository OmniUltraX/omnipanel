import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { errorToString } from "../../../lib/errorToString";
import { optionalNumber, optionalString, requireString } from "../../../lib/ai/mcpToolArgs";
import {
  createDatabase,
  introspectTable,
  isConnectionEnabled,
  isSqlCapableConnection,
  listCharacterSets,
  listConnectionUsers,
  listConnections,
  listDatabases,
  listTables,
  previewTable,
  type DbConnectionConfig,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import { runWithToolGate } from "../../../lib/ai/toolGate";
import { makeQueryRunId } from "../sql/queryRun";
import type { QueryResult } from "../workspace/dbWorkspaceState";
import { useDbSqlFileStore } from "../../../stores/dbSqlFileStore";

function assertSqlIdentifier(name: string, label: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_$-]+$/.test(trimmed)) {
    throw new Error(`${label} 含非法字符：${name}`);
  }
  return trimmed;
}

function filterByKeyword(items: string[], keyword?: string): string[] {
  if (!keyword) return items;
  const lower = keyword.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(lower));
}

async function resolveEnabledConnection(connectionName: string): Promise<DbConnectionConfig> {
  const connections = await listConnections();
  const conn = connections.find(
    (item) => item.name === connectionName || item.id === connectionName,
  );
  if (!conn) {
    throw new Error(`连接不存在：${connectionName}`);
  }
  if (!isConnectionEnabled(conn)) {
    throw new Error(`连接已禁用：${connectionName}`);
  }
  return conn;
}

async function resolveConnectionByName(connectionName: string): Promise<DbConnectionConfig> {
  const conn = await resolveEnabledConnection(connectionName);
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

  const run = async () => {
    const result = await invoke<QueryResult>("db_execute_query", {
      connection: conn,
      sql,
      runId: makeQueryRunId(),
      limit: 500,
      offset: 0,
    });
    return formatQueryResult(result);
  };

  return runWithToolGate(
    {
      toolName: "omni_database_execute_sql",
      args,
      resourceId: connectionName,
      channel: "ui-delegated",
    },
    run,
  );
}

function assertSqlScriptName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("缺少必填参数：name");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`脚本文件名仅允许字母/数字/点/下划线/连字符：${name}`);
  }
  return trimmed.toLowerCase().endsWith(".sql") ? trimmed : `${trimmed}.sql`;
}

/**
 * 创建 SQL 脚本文件并立即执行（对标 omni_ssh_create_run_script）。
 * 落盘到数据库模块 SQL 文件树，绑定连接/库，适合多语句复杂逻辑。
 */
async function createRunSql(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = requireString(args, "database_name");
  const name = assertSqlScriptName(requireString(args, "name"));
  const sql = requireString(args, "sql");
  const baseConn = await resolveConnectionByName(connectionName);
  const conn = connectionWithDatabase(baseConn, databaseName);

  const run = async () => {
    const store = useDbSqlFileStore.getState();
    const file = store.addFile(null, name, sql);
    store.updateFileBinding(file.id, baseConn.id, databaseName);
    await store.flushToDisk();

    const result = await invoke<QueryResult>("db_execute_query", {
      connection: conn,
      sql,
      runId: makeQueryRunId(),
    });

    return JSON.stringify(
      {
        connection: connectionName,
        connectionId: baseConn.id,
        database: databaseName,
        name: file.name,
        fileId: file.id,
        created: true,
        result:
          result.columns.length === 0
            ? { rowsAffected: result.rowsAffected }
            : {
                columns: result.columns,
                rows: result.rows,
                rowsAffected: result.rowsAffected,
              },
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
  };

  return runWithToolGate(
    {
      toolName: "omni_database_create_run_sql",
      args,
      resourceId: connectionName,
      channel: "ui-delegated",
    },
    run,
  );
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

  const run = async () => {
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
        throw new Error(`PostgreSQL query_id 必须是正整数（pid）：${pid}`);
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
  };

  return runWithToolGate(
    {
      toolName: "omni_database_kill_query",
      args,
      resourceId: connectionName,
      channel: "ui-delegated",
    },
    run,
  );
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
    const msg = errorToString(e);
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

async function createDatabaseTool(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName =
    optionalString(args, "database_name") ?? optionalString(args, "name");
  if (!databaseName) {
    throw new Error("缺少必填参数：database_name");
  }
  const charset = optionalString(args, "charset") ?? null;
  const collation = optionalString(args, "collation") ?? null;
  const conn = await resolveEnabledConnection(connectionName);

  return runWithToolGate(
    {
      toolName: "omni_database_create_database",
      args,
      resourceId: connectionName,
      channel: "ui-delegated",
    },
    async () => {
      const created = await createDatabase({
        connection: conn,
        name: databaseName,
        charset,
        collation,
      });
      return JSON.stringify(
        {
          connection: connectionName,
          connectionId: conn.id,
          database: created,
          created: true,
        },
        null,
        2,
      );
    },
  );
}

async function listUsersTool(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const keyword = optionalString(args, "keyword");
  const conn = await resolveEnabledConnection(connectionName);
  const users = await listConnectionUsers(conn, { quiet: true });
  const filtered = keyword
    ? users.filter((u) => {
        const q = keyword.toLowerCase();
        return (
          u.name.toLowerCase().includes(q) ||
          (u.host ?? "").toLowerCase().includes(q)
        );
      })
    : users;
  return JSON.stringify(
    { connection: connectionName, connectionId: conn.id, users: filtered },
    null,
    2,
  );
}

async function previewTableTool(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const databaseName = requireString(args, "database_name");
  const tableName = assertSqlIdentifier(requireString(args, "table_name"), "表名");
  const limit = Math.min(500, Math.max(1, Math.floor(optionalNumber(args, "limit", 200))));
  const offset = Math.max(0, Math.floor(optionalNumber(args, "offset", 0)));
  const orderBy = optionalString(args, "order_by");
  const whereClause = optionalString(args, "where_clause");
  const conn = connectionWithDatabase(
    await resolveEnabledConnection(connectionName),
    databaseName,
  );
  const preview = await previewTable(conn, tableName, limit, offset, orderBy, whereClause);
  return JSON.stringify(
    {
      connection: connectionName,
      connectionId: conn.id,
      database: databaseName,
      table: tableName,
      limit,
      offset,
      name: preview.name,
      columns: preview.columns,
      rows: preview.rows,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

async function listCharacterSetsTool(args: Record<string, unknown>): Promise<string> {
  const connectionName = requireString(args, "connection_name");
  const conn = await resolveEnabledConnection(connectionName);
  const charsets = await listCharacterSets(conn);
  return JSON.stringify(
    { connection: connectionName, connectionId: conn.id, charsets },
    null,
    2,
  );
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
    name: "omni_database_create_run_sql",
    description:
      "创建 SQL 脚本并立即执行：写入数据库模块 SQL 文件树（同名自动去重），绑定连接/数据库后执行。\
适合多语句迁移、批处理或需落盘复用的复杂逻辑；简单单条查询优先用 omni_database_execute_sql。危险 SQL 会进入用户确认流程。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: databaseNameSchema,
        name: {
          type: "string",
          description:
            "脚本文件名（仅字母/数字/点/下划线/连字符）；可省略 .sql 后缀",
        },
        sql: {
          type: "string",
          description: "脚本正文（可含多条语句与复杂逻辑）",
        },
      },
      required: ["connection_name", "database_name", "name", "sql"],
    },
    handler: createRunSql,
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
  {
    name: "omni_database_create_database",
    description:
      "按工作台建库对话框创建数据库（同路径 db_create_database）。可选 charset/collation；危险操作需用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: {
          type: "string",
          description: "要创建的数据库名（也可传 name）",
        },
        name: {
          type: "string",
          description: "database_name 的别名，与工作台建库对话框字段一致",
        },
        charset: {
          type: "string",
          description: "可选。MySQL 为 CHARACTER SET，PostgreSQL 为 ENCODING",
        },
        collation: {
          type: "string",
          description: "可选。MySQL 为 COLLATE，PostgreSQL 为 LC_COLLATE",
        },
      },
      required: ["connection_name", "database_name"],
    },
    handler: createDatabaseTool,
  },
  {
    name: "omni_database_list_users",
    description:
      "列出连接上的数据库用户（与工作台「用户」页签同一路径）。可选 keyword 过滤。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        keyword: keywordSchema,
      },
      required: ["connection_name"],
    },
    handler: listUsersTool,
  },
  {
    name: "omni_database_preview_table",
    description:
      "预览表数据（与工作台表预览同一路径）。支持 limit/offset/order_by/where_clause；行返回列名到值的对象。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
        database_name: databaseNameSchema,
        table_name: {
          type: "string",
          description: "表名",
        },
        limit: {
          type: "integer",
          description: "返回行数，默认 200，范围 1~500",
          default: 200,
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: "integer",
          description: "偏移量，默认 0",
          default: 0,
          minimum: 0,
        },
        order_by: {
          type: "string",
          description: "可选，不含 ORDER BY 关键字的排序子句",
        },
        where_clause: {
          type: "string",
          description: "可选，不含 WHERE 关键字的过滤条件",
        },
      },
      required: ["connection_name", "database_name", "table_name"],
    },
    handler: previewTableTool,
  },
  {
    name: "omni_database_list_character_sets",
    description:
      "列出连接可用字符集/编码（与工作台建库对话框同一路径），供创建数据库时选择 charset。",
    inputSchema: {
      type: "object",
      properties: {
        connection_name: connectionNameSchema,
      },
      required: ["connection_name"],
    },
    handler: listCharacterSetsTool,
  },
];
