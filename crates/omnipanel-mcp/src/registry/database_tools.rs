//! 数据库 MCP 工具 — OmniMCP / 内部 Native 路径共用。

use omnipanel_db::{connect, mysql_connect_options, DbParams, QueryResult};
use omnipanel_store::{load_database_connections, DbConnectionConfig};
use serde_json::Value;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::Row;

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少必填参数: {key}"))
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn keyword_filter(items: &[String], keyword: Option<&str>) -> Vec<String> {
    let Some(kw) = keyword.map(str::trim).filter(|s| !s.is_empty()) else {
        return items.to_vec();
    };
    let lower = kw.to_ascii_lowercase();
    items
        .iter()
        .filter(|item| item.to_ascii_lowercase().contains(&lower))
        .cloned()
        .collect()
}

fn assert_sql_identifier(name: &str, label: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    {
        return Err(format!("{label} 含非法字符：{name}"));
    }
    Ok(trimmed.to_string())
}

fn to_params(c: &DbConnectionConfig) -> DbParams {
    DbParams {
        db_type: c.db_type.clone(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        password: c.password.clone(),
        database: c.database.clone(),
        ssl: c.ssl,
    }
}

fn with_database(c: &DbConnectionConfig, database_name: &str) -> DbParams {
    let mut params = to_params(c);
    params.database = database_name.to_string();
    params
}

fn mysql_row_string(row: &MySqlRow, index: usize) -> String {
    if let Ok(v) = row.try_get::<String, _>(index) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(index) {
        return String::from_utf8_lossy(&v).into_owned();
    }
    String::new()
}

async fn mysql_pool(connection: &DbConnectionConfig) -> Result<MySqlPool, String> {
    let opts = mysql_connect_options(&to_params(connection));
    MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))
}

async fn resolve_connection(connection_name: &str) -> Result<DbConnectionConfig, String> {
    let conn = resolve_connection_any(connection_name).await?;
    let db_type = conn.db_type.to_ascii_lowercase();
    if db_type == "redis" {
        return Err(format!("连接 {connection_name} 为 Redis，请使用 Redis 专用工具"));
    }
    Ok(conn)
}

/// 与 `resolve_connection` 相同，但不拒绝 Redis（processlist / kill / slow_log 支持 Redis）。
async fn resolve_connection_any(connection_name: &str) -> Result<DbConnectionConfig, String> {
    let connections = load_database_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .into_iter()
        .find(|c| c.name == connection_name)
        .ok_or_else(|| format!("连接不存在：{connection_name}"))?;
    if !conn.enabled {
        return Err(format!("连接已禁用：{connection_name}"));
    }
    Ok(conn)
}

fn format_query_result(result: &QueryResult) -> String {
    let payload = if result.columns.is_empty() {
        serde_json::json!({ "rowsAffected": result.rows_affected })
    } else {
        serde_json::json!({
            "columns": result.columns,
            "rows": result.rows,
            "rowsAffected": result.rows_affected,
        })
    };
    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
}

pub async fn get_databases_from_connection(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let keyword = optional_str(&args, "keyword");
    let conn = resolve_connection(&connection_name).await?;

    let databases = match conn.db_type.to_ascii_lowercase().as_str() {
        "mysql" | "mariadb" => {
            let pool = mysql_pool(&conn).await?;
            let rows = sqlx::query(
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
            let list: Vec<String> = rows.iter().map(|r| mysql_row_string(r, 0)).collect();
            pool.close().await;
            list
        }
        "redis" => {
            let preset = conn.database.trim();
            if preset.is_empty() {
                (0..16).map(|n| n.to_string()).collect()
            } else {
                vec![preset.to_string()]
            }
        }
        _ if !conn.database.trim().is_empty() => vec![conn.database.clone()],
        _ => vec![],
    };

    let filtered = keyword_filter(&databases, keyword.as_deref());
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "connection": connection_name,
        "databases": filtered,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

pub async fn get_tables_from_database(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let database_name = require_str(&args, "database_name")?;
    let keyword = optional_str(&args, "keyword");
    let conn = resolve_connection(&connection_name).await?;
    let params = with_database(&conn, &database_name);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await.map_err(|e| e.user_message())?;
    let tables = driver.list_tables().await.map_err(|e| e.user_message())?;
    let filtered = keyword_filter(&tables, keyword.as_deref());
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "connection": connection_name,
        "database": database_name,
        "tables": filtered,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

pub async fn get_table_info(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let database_name = require_str(&args, "database_name")?;
    let table_name = assert_sql_identifier(&require_str(&args, "table_name")?, "表名")?;
    let conn = resolve_connection(&connection_name).await?;
    let params = with_database(&conn, &database_name);
    let engine = conn.db_type.to_ascii_lowercase();

    let driver = connect(&params).await.map_err(|e| e.user_message())?;
    let sql = match engine.as_str() {
        "mysql" | "mariadb" => format!("DESC `{table_name}`"),
        "sqlite" | "sqlite3" => format!("PRAGMA table_info('{table_name}')"),
        "postgres" | "postgresql" | "pg" => format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_schema = current_schema() AND table_name = '{table_name}' \
             ORDER BY ordinal_position"
        ),
        other => return Err(format!("暂不支持 {other} 的表结构 introspect")),
    };
    let result = driver.execute(&sql).await.map_err(|e| e.user_message())?;
    Ok(format_query_result(&result))
}

pub async fn execute_sql(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let database_name = require_str(&args, "database_name")?;
    let sql = require_str(&args, "sql")?;
    let conn = resolve_connection(&connection_name).await?;
    let params = with_database(&conn, &database_name);
    let wrapped = omnipanel_db::wrap_select_with_limit(&sql, 500, 0);
    let driver = connect(&params).await.map_err(|e| e.user_message())?;
    let result = driver.execute(&wrapped).await.map_err(|e| e.user_message())?;
    Ok(format_query_result(&result))
}

/// 查看数据库当前会话/进程列表，用于排查长运行查询、锁等待。
pub async fn show_processlist(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let database_name = optional_str(&args, "database_name");
    let conn = resolve_connection_any(&connection_name).await?;
    let engine = conn.db_type.to_ascii_lowercase();
    let params = match &database_name {
        Some(db) if !db.trim().is_empty() => with_database(&conn, db),
        _ => to_params(&conn),
    };

    match engine.as_str() {
        "mysql" | "mariadb" => {
            let driver = connect(&params).await.map_err(|e| e.user_message())?;
            let sql = "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO \
                       FROM information_schema.PROCESSLIST \
                       ORDER BY TIME DESC";
            let result = driver.execute(sql).await.map_err(|e| e.user_message())?;
            Ok(format_query_result(&result))
        }
        "postgres" | "postgresql" | "pg" => {
            let driver = connect(&params).await.map_err(|e| e.user_message())?;
            let sql = "SELECT pid, usename AS user_name, datname AS database, \
                       client_addr::text AS client_addr, application_name, \
                       backend_start, state, query_start, state_change, \
                       wait_event_type, wait_event, query \
                       FROM pg_stat_activity \
                       WHERE state IS NOT NULL \
                       ORDER BY query_start DESC NULLS LAST";
            let result = driver.execute(sql).await.map_err(|e| e.user_message())?;
            Ok(format_query_result(&result))
        }
        "redis" => {
            let result =
                omnipanel_db::redis_client_list(&params).await.map_err(|e| e.user_message())?;
            Ok(format_query_result(&result))
        }
        other => Err(format!("暂不支持 {other} 的 show_processlist")),
    }
}

/// 终止指定会话/查询。危险操作。
pub async fn kill_query(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let query_id = require_str(&args, "query_id")?;
    let conn = resolve_connection_any(&connection_name).await?;
    let engine = conn.db_type.to_ascii_lowercase();
    let params = to_params(&conn);

    match engine.as_str() {
        "mysql" | "mariadb" => {
            let id: u64 = query_id.parse().map_err(|_| {
                format!("MySQL/MariaDB query_id 必须是数字（PROCESSLIST_ID）：{query_id}")
            })?;
            let pool = mysql_pool(&conn).await?;
            let sql = format!("KILL {id}");
            let result = sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| format!("KILL 失败: {e}"))?;
            pool.close().await;
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "connection": connection_name,
                "query_id": query_id,
                "rowsAffected": result.rows_affected(),
                "message": "已发送 KILL 命令",
            }))
            .unwrap_or_else(|_| "{}".to_string()))
        }
        "postgres" | "postgresql" | "pg" => {
            let pid: i32 = query_id
                .parse()
                .map_err(|_| format!("PostgreSQL query_id 必须是数字（pid）：{query_id}"))?;
            let driver = connect(&params).await.map_err(|e| e.user_message())?;
            let sql = format!("SELECT pg_terminate_backend({pid}) AS terminated");
            let result = driver.execute(&sql).await.map_err(|e| e.user_message())?;
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "connection": connection_name,
                "query_id": query_id,
                "result": serde_json::from_str::<Value>(&format_query_result(&result))
                    .unwrap_or(Value::Null),
            }))
            .unwrap_or_else(|_| "{}".to_string()))
        }
        "redis" => {
            let killed = omnipanel_db::redis_client_kill_addr(&params, &query_id)
                .await
                .map_err(|e| e.user_message())?;
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "connection": connection_name,
                "query_id": query_id,
                "killed": killed,
                "message": if killed > 0 {
                    "CLIENT KILL 成功"
                } else {
                    "未找到匹配的客户端（可能已断开）"
                },
            }))
            .unwrap_or_else(|_| "{}".to_string()))
        }
        other => Err(format!("暂不支持 {other} 的 kill_query")),
    }
}

/// 汇总慢查询日志。
pub async fn slow_log_summary(args: Value) -> Result<String, String> {
    let connection_name = require_str(&args, "connection_name")?;
    let database_name = optional_str(&args, "database_name");
    let count = args
        .get("count")
        .and_then(|v| v.as_i64())
        .unwrap_or(10)
        .clamp(1, 100) as usize;
    let conn = resolve_connection_any(&connection_name).await?;
    let engine = conn.db_type.to_ascii_lowercase();
    let params = match &database_name {
        Some(db) if !db.trim().is_empty() => with_database(&conn, db),
        _ => to_params(&conn),
    };

    match engine.as_str() {
        "mysql" | "mariadb" => {
            let driver = connect(&params).await.map_err(|e| e.user_message())?;
            // 优先查 performance_schema.events_statements_summary_by_digest
            // （按平均执行时间倒序，包含 SCHEMA_NAME / DIGEST_TEXT / 调用次数 / 总耗时 / 行扫描等）
            let sql = format!(
                "SELECT SCHEMA_NAME AS db, DIGEST_TEXT AS query, \
                 COUNT_STAR AS exec_count, \
                 ROUND(SUM_TIMER_WAIT/1000000000000, 3) AS total_sec, \
                 ROUND(AVG_TIMER_WAIT/1000000000, 3) AS avg_ms, \
                 SUM_ROWS_EXAMINED AS rows_examined, \
                 SUM_ROWS_SENT AS rows_sent, \
                 FIRST_SEEN, LAST_SEEN \
                 FROM performance_schema.events_statements_summary_by_digest \
                 WHERE SCHEMA_NAME IS NOT NULL \
                 ORDER BY AVG_TIMER_WAIT DESC LIMIT {count}"
            );
            let result = driver.execute(&sql).await;
            match result {
                Ok(r) if !r.rows.is_empty() => Ok(format_query_result(&r)),
                Ok(_) => {
                    // performance_schema 没数据，尝试 mysql.slow_log（需 log_output=TABLE）
                    let sql2 = format!(
                        "SELECT start_time, user_host, query_time, lock_time, \
                         rows_sent, rows_examined, sql_text \
                         FROM mysql.slow_log ORDER BY start_time DESC LIMIT {count}"
                    );
                    let r2 = driver.execute(&sql2).await.map_err(|e| e.user_message())?;
                    Ok(serde_json::to_string_pretty(&serde_json::json!({
                        "connection": connection_name,
                        "source": "mysql.slow_log",
                        "result": serde_json::from_str::<Value>(&format_query_result(&r2))
                            .unwrap_or(Value::Null),
                    }))
                    .unwrap_or_else(|_| "{}".to_string()))
                }
                Err(e) => {
                    let msg = e.user_message();
                    if msg.contains("doesn't exist") || msg.contains("Unknown table") {
                        Err(format!(
                            "性能 schema 不可用：{msg}。请检查 performance_schema 是否启用，或开启 slow_query_log + log_output=TABLE 后用 mysql.slow_log"
                        ))
                    } else {
                        Err(msg)
                    }
                }
            }
        }
        "postgres" | "postgresql" | "pg" => {
            let driver = connect(&params).await.map_err(|e| e.user_message())?;
            // pg_stat_statements 扩展需先 CREATE EXTENSION pg_stat_statements;
            let sql = format!(
                "SELECT query, calls, round(total_exec_time::numeric, 3) AS total_ms, \
                 round(mean_exec_time::numeric, 3) AS mean_ms, \
                 rows, shared_blks_hit, shared_blks_read, shared_blks_written \
                 FROM pg_stat_statements \
                 ORDER BY mean_exec_time DESC LIMIT {count}"
            );
            let result = driver.execute(&sql).await.map_err(|e| {
                let msg = e.user_message();
                if msg.contains("pg_stat_statements") || msg.contains("does not exist") {
                    format!(
                        "pg_stat_statements 扩展未启用：{msg}。请在目标库执行 `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` 并在 postgresql.conf 添加 `shared_preload_libraries = 'pg_stat_statements'`"
                    )
                } else {
                    msg
                }
            })?;
            Ok(format_query_result(&result))
        }
        "redis" => {
            let entries = omnipanel_db::redis_slowlog(&params, count)
                .await
                .map_err(|e| e.user_message())?;
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "connection": connection_name,
                "source": "SLOWLOG GET",
                "entries": entries,
            }))
            .unwrap_or_else(|_| "{}".to_string()))
        }
        other => Err(format!("暂不支持 {other} 的 slow_log_summary")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn require_str_rejects_missing_or_empty() {
        let args = json!({ "connection_name": "" });
        let err = require_str(&args, "connection_name").unwrap_err();
        assert!(err.contains("缺少必填参数"));

        let args = json!({});
        let err = require_str(&args, "connection_name").unwrap_err();
        assert!(err.contains("缺少必填参数"));
    }

    #[test]
    fn require_str_trims_whitespace() {
        let args = json!({ "connection_name": "  prod-mysql  " });
        let name = require_str(&args, "connection_name").unwrap();
        assert_eq!(name, "prod-mysql");
    }

    #[test]
    fn optional_str_returns_none_for_missing_or_blank() {
        let args = json!({});
        assert!(optional_str(&args, "database_name").is_none());

        let args = json!({ "database_name": "   " });
        assert!(optional_str(&args, "database_name").is_none());

        let args = json!({ "database_name": "shop" });
        assert_eq!(optional_str(&args, "database_name").as_deref(), Some("shop"));
    }

    #[test]
    fn keyword_filter_case_insensitive() {
        let items = vec!["Users".to_string(), "orders".to_string(), "Products".to_string()];
        let filtered = keyword_filter(&items, Some("ORD"));
        assert_eq!(filtered, vec!["orders".to_string()]);

        let filtered = keyword_filter(&items, Some("user"));
        assert_eq!(filtered, vec!["Users".to_string()]);
    }

    #[test]
    fn assert_sql_identifier_rejects_special_chars() {
        assert!(assert_sql_identifier("users", "表名").is_ok());
        assert!(assert_sql_identifier("user_1", "表名").is_ok());
        assert!(assert_sql_identifier("user$1", "表名").is_ok());
        // 含分号 / 引号 / 空格 应拒绝
        assert!(assert_sql_identifier("users; DROP TABLE x", "表名").is_err());
        assert!(assert_sql_identifier("`users`", "表名").is_err());
        assert!(assert_sql_identifier("user name", "表名").is_err());
    }

    #[test]
    fn slow_log_summary_count_clamps_to_range() {
        // count 缺失 -> 默认 10
        let args = json!({ "connection_name": "x" });
        let count = args.get("count").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 100);
        assert_eq!(count, 10);

        // count=0 -> 1
        let args = json!({ "count": 0 });
        let count = args.get("count").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 100);
        assert_eq!(count, 1);

        // count=999 -> 100
        let args = json!({ "count": 999 });
        let count = args.get("count").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 100);
        assert_eq!(count, 100);

        // count=50 -> 50
        let args = json!({ "count": 50 });
        let count = args.get("count").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 100);
        assert_eq!(count, 50);
    }

    #[tokio::test]
    async fn show_processlist_unknown_engine_returns_friendly_error() {
        // 不存在的连接名应返回 "连接不存在" 错误
        let args = json!({ "connection_name": "__nonexistent_conn__" });
        let err = show_processlist(args).await.unwrap_err();
        assert!(err.contains("连接不存在"));
    }

    #[tokio::test]
    async fn kill_query_missing_query_id_returns_param_error() {
        let args = json!({ "connection_name": "__nonexistent_conn__" });
        // query_id 缺失，应先报参数错误（而不是去查连接）
        let err = kill_query(args).await.unwrap_err();
        assert!(err.contains("缺少必填参数"));
    }
}
