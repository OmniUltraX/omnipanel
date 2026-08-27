/** 连接信息 extra / 方言慢查询 SQL，与后端 sidecar_catalog 对齐。 */

import {
  catalogFamily,
  canonicalHostEngine,
} from "./hostCapabilities";

export const PG_PROCESSLIST_SQL =
  "SELECT pid AS Id, usename AS \"User\", client_addr AS Host, datname AS db, state AS State, query AS Query, " +
  "EXTRACT(EPOCH FROM now() - query_start)::bigint AS Time " +
  "FROM pg_stat_activity WHERE datname IS NOT NULL ORDER BY Time DESC";

export const PG_VARIABLES_SQL =
  "SELECT name, setting, source, context FROM pg_settings ORDER BY name";

export const PG_SLOW_QUERY_SQLS = [
  "SELECT query, calls, total_exec_time, mean_exec_time, rows FROM pg_stat_statements ORDER BY total_exec_time DESC NULLS LAST LIMIT 100",
  "SELECT query, calls, total_time, mean_time, rows FROM pg_stat_statements ORDER BY total_time DESC NULLS LAST LIMIT 100",
];

export const MYSQL_PROCESSLIST_SQL = "SHOW FULL PROCESSLIST;";
export const MYSQL_VARIABLES_SQL = "SHOW VARIABLES;";

export const ORACLE_PROCESSLIST_SQLS = [
  "SELECT SID AS Id, USERNAME AS \"User\", MACHINE AS Host, SCHEMANAME AS db, STATUS AS State, SQL_ID AS Query, LAST_CALL_ET AS Time FROM V$SESSION WHERE USERNAME IS NOT NULL ORDER BY LAST_CALL_ET DESC",
  "SELECT SESS_ID AS Id, USER_NAME AS \"User\", CLNT_HOST AS Host, CURR_SCH AS db, STATE AS State, SQL_TEXT AS Query FROM V$SESSIONS WHERE USER_NAME IS NOT NULL",
];

export const ORACLE_VARIABLES_SQLS = [
  "SELECT NAME, VALUE, ISDEFAULT AS source, DESCRIPTION AS context FROM V$PARAMETER ORDER BY NAME",
  "SELECT NAME, VALUE FROM V$PARAMETER ORDER BY NAME",
];

export const ORACLE_SLOW_QUERY_SQLS = [
  "SELECT SQL_ID, SQL_TEXT, ELAPSED_TIME/1000000 AS elapsed_sec, EXECUTIONS, DISK_READS FROM V$SQL WHERE ROWNUM <= 100 ORDER BY ELAPSED_TIME DESC",
  "SELECT SQL_TEXT, EXECUTIONS, ELAPSED_TIME FROM V$SQL WHERE ROWNUM <= 100",
];

export const MSSQL_PROCESSLIST_SQL =
  "SELECT session_id AS Id, login_name AS \"User\", host_name AS Host, DB_NAME(database_id) AS db, status AS State, " +
  "DATEDIFF(second, login_time, GETDATE()) AS Time FROM sys.dm_exec_sessions WHERE is_user_process = 1 ORDER BY Time DESC";

export const MSSQL_VARIABLES_SQL =
  "SELECT name, CAST(value AS nvarchar(max)) AS setting, CAST(value_in_use AS nvarchar(max)) AS source, description AS context FROM sys.configurations ORDER BY name";

export const MSSQL_SLOW_QUERY_SQL =
  "SELECT TOP 100 qs.total_elapsed_time / 1000 AS elapsed_ms, qs.execution_count, SUBSTRING(qt.text, 1, 4000) AS query " +
  "FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt ORDER BY qs.total_elapsed_time DESC";

export function processListSqls(dbType: string): string[] {
  const engine = canonicalHostEngine(dbType);
  if (engine === "sqlserver") return [MSSQL_PROCESSLIST_SQL];
  const family = catalogFamily(engine);
  if (family === "postgresLike") return [PG_PROCESSLIST_SQL];
  if (family === "oracleLike") return [...ORACLE_PROCESSLIST_SQLS];
  return [MYSQL_PROCESSLIST_SQL];
}

export function settingsSqls(dbType: string): string[] {
  const engine = canonicalHostEngine(dbType);
  if (engine === "sqlserver") return [MSSQL_VARIABLES_SQL];
  const family = catalogFamily(engine);
  if (family === "postgresLike") return [PG_VARIABLES_SQL];
  if (family === "oracleLike") return [...ORACLE_VARIABLES_SQLS];
  return [MYSQL_VARIABLES_SQL];
}

export function slowQuerySqls(dbType: string): string[] {
  const engine = canonicalHostEngine(dbType);
  if (engine === "sqlserver") return [MSSQL_SLOW_QUERY_SQL];
  const family = catalogFamily(engine);
  if (family === "postgresLike") return [...PG_SLOW_QUERY_SQLS];
  if (family === "oracleLike") return [...ORACLE_SLOW_QUERY_SQLS];
  return [];
}
