import { invoke } from "@tauri-apps/api/core";

import type { McpToolRegistration } from "../../../lib/ai/context";
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
import type { QueryResult } from "../dbWorkspaceState";

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少必填参数：${key}`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`参数 ${key} 必须是字符串`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
    limit: 500,
    offset: 0,
  });
  return formatQueryResult(result);
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

/** 数据库模块向 AI 注册的 MCP 工具 */
export const DATABASE_MODULE_MCP_TOOLS: McpToolRegistration[] = [
  {
    name: "get_databases_from_connection",
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
    name: "get_tables_from_database",
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
    name: "get_table_info",
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
    name: "execute_sql",
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
];
