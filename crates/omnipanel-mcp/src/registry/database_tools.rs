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
    let connections = load_database_connections().map_err(|e| e.to_string())?;
    let conn = connections
        .into_iter()
        .find(|c| c.name == connection_name)
        .ok_or_else(|| format!("连接不存在：{connection_name}"))?;
    if !conn.enabled {
        return Err(format!("连接已禁用：{connection_name}"));
    }
    let db_type = conn.db_type.to_ascii_lowercase();
    if db_type == "redis" {
        return Err(format!("连接 {connection_name} 为 Redis，请使用 Redis 专用工具"));
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
