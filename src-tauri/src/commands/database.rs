use std::collections::HashMap;

use omnipanel_db::{DbParams, QueryResult, mysql_connect_options};
use omnipanel_error::OmniError;
pub use omnipanel_store::{
    DbConnectionConfig, SchemaFiltersSnapshot, load_schema_filters, prune_connection_filters,
    save_schema_filters,
};
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::Row;
use tauri::State;

use crate::state::AppState;

/// `information_schema` 部分列在 MySQL 驱动下为 BLOB，需兼容解码为 `String`。
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
    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return String::from_utf8_lossy(&v).into_owned();
    }
    String::new()
}

fn mysql_row_i32(row: &MySqlRow, index: usize, default: i32) -> i32 {
    if let Ok(v) = row.try_get::<i32, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<i8, _>(index) {
        return i32::from(v);
    }
    if let Ok(v) = row.try_get::<u8, _>(index) {
        return i32::from(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return v as i32;
    }
    mysql_row_string(row, index)
        .parse()
        .unwrap_or(default)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub is_pk: bool,
    pub is_fk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbIndexMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DbTableSchema {
    pub name: String,
    pub columns: Vec<DbColumnMeta>,
    #[serde(default)]
    pub indexes: Vec<DbIndexMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DbIntrospectResult {
    pub database: String,
    pub tables: Vec<DbTableSchema>,
}

/// 将领域错误转为前端可读文案（含底层 cause）。
fn err_msg(e: OmniError) -> String {
    e.user_message()
}

/// 将 IPC 连接配置转换为 omnipanel-db 的领域连接参数。
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

async fn mysql_pool(connection: &DbConnectionConfig) -> Result<MySqlPool, String> {
    let opts = mysql_connect_options(&to_params(connection));
    MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))
}

fn with_schema(c: &DbConnectionConfig, schema: Option<String>) -> DbParams {
    let mut params = to_params(c);
    if let Some(s) = schema.filter(|name| !name.trim().is_empty()) {
        params.database = s;
    }
    params
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<DbConnectionConfig>, String> {
    state
        .db_connections
        .list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_connection(
    state: State<'_, AppState>,
    connection: DbConnectionConfig,
) -> Result<DbConnectionConfig, String> {
    state
        .db_connections
        .save(connection)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db_connections
        .delete(&id)
        .map_err(|e| e.to_string())?;
    let mut filters = load_schema_filters().map_err(|e| e.to_string())?;
    prune_connection_filters(&mut filters, &id);
    save_schema_filters(&filters).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn db_load_schema_filters() -> Result<SchemaFiltersSnapshot, String> {
    load_schema_filters().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_schema_filters(snapshot: SchemaFiltersSnapshot) -> Result<(), String> {
    save_schema_filters(&snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_test_connection(connection: DbConnectionConfig) -> Result<String, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    driver.version().await.map_err(err_msg)
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_databases(connection: DbConnectionConfig) -> Result<Vec<String>, String> {
    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            let pool = mysql_pool(&connection).await?;
            let rows = sqlx::query(
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
                 WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') \
                 ORDER BY SCHEMA_NAME",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
            let databases: Vec<String> = rows.iter().map(|r| mysql_row_string(r, 0)).collect();
            pool.close().await;
            Ok(databases)
        }
        _ if !connection.database.trim().is_empty() => Ok(vec![connection.database.clone()]),
        _ => Ok(vec![]),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_introspect_schema(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<DbIntrospectResult, String> {
    let db_name = schema
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| connection.database.clone());
    if db_name.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }

    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => introspect_mysql_schema(&connection, &db_name).await,
        _ => {
            let params = with_schema(&connection, Some(db_name.clone()));
            let driver = omnipanel_db::connect(&params)
                .await
                .map_err(err_msg)?;
            let table_names = driver.list_tables().await.map_err(err_msg)?;
            Ok(DbIntrospectResult {
                database: db_name,
                tables: table_names
                    .into_iter()
                    .map(|name| DbTableSchema {
                        name,
                        columns: Vec::new(),
                        indexes: Vec::new(),
                    })
                    .collect(),
            })
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_introspect_table(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DbTableSchema, String> {
    let db_name = schema
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| connection.database.clone());
    if db_name.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    if table.trim().is_empty() {
        return Err("未指定数据表".to_string());
    }

    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            introspect_mysql_table(&connection, &db_name, table.trim()).await
        }
        _ => Ok(DbTableSchema {
            name: table,
            columns: Vec::new(),
            indexes: Vec::new(),
        }),
    }
}

async fn introspect_mysql_schema(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<DbIntrospectResult, String> {
    let pool = mysql_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? \
         ORDER BY TABLE_NAME, ORDINAL_POSITION",
    )
    .bind(db_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? \
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(db_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;
    pool.close().await;

    let mut tables: Vec<DbTableSchema> = Vec::new();
    for row in &col_rows {
        let table_name = mysql_row_string(row, 0);
        let column_name = mysql_row_string(row, 1);
        let data_type = mysql_row_string(row, 2);
        let column_key = mysql_row_string(row, 3);
        let is_pk = column_key == "PRI";
        let is_fk = column_key == "MUL";

        if let Some(table) = tables.iter_mut().find(|t| t.name == table_name) {
            table.columns.push(DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk,
                is_fk,
            });
        } else {
            tables.push(DbTableSchema {
                name: table_name,
                columns: vec![DbColumnMeta {
                    name: column_name,
                    column_type: data_type,
                    is_pk,
                    is_fk,
                }],
                indexes: Vec::new(),
            });
        }
    }

    apply_mysql_index_rows(&mut tables, idx_rows);

    Ok(DbIntrospectResult {
        database: db_name.to_string(),
        tables,
    })
}

async fn introspect_mysql_table(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let pool = mysql_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(db_name)
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(db_name)
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;
    pool.close().await;

    let columns: Vec<DbColumnMeta> = col_rows
        .iter()
        .map(|row| {
            let column_name = mysql_row_string(row, 0);
            let data_type = mysql_row_string(row, 1);
            let column_key = mysql_row_string(row, 2);
            DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk: column_key == "PRI",
                is_fk: column_key == "MUL",
            }
        })
        .collect();

    let mut table = DbTableSchema {
        name: table_name.to_string(),
        columns,
        indexes: Vec::new(),
    };
    push_mysql_index_row(&mut table.indexes, idx_rows);
    Ok(table)
}

fn push_mysql_index_row(indexes: &mut Vec<DbIndexMeta>, idx_rows: Vec<sqlx::mysql::MySqlRow>) {
    for row in &idx_rows {
        let index_name = mysql_row_string(row, 0);
        let column_name = mysql_row_string(row, 1);
        let non_unique = mysql_row_i32(row, 2, 1);
        if index_name == "PRIMARY" {
            continue;
        }
        let unique = non_unique == 0;
        if let Some(index) = indexes.iter_mut().find(|i| i.name == index_name) {
            index.columns.push(column_name);
        } else {
            indexes.push(DbIndexMeta {
                name: index_name,
                columns: vec![column_name],
                unique,
            });
        }
    }
}

fn apply_mysql_index_rows(tables: &mut [DbTableSchema], idx_rows: Vec<sqlx::mysql::MySqlRow>) {
    for row in &idx_rows {
        let table_name = mysql_row_string(row, 0);
        let index_name = mysql_row_string(row, 1);
        let column_name = mysql_row_string(row, 2);
        let non_unique = mysql_row_i32(row, 3, 1);
        let table = match tables.iter_mut().find(|t| t.name == table_name) {
            Some(t) => t,
            None => continue,
        };
        if index_name == "PRIMARY" {
            continue;
        }
        let unique = non_unique == 0;
        if let Some(index) = table.indexes.iter_mut().find(|i| i.name == index_name) {
            index.columns.push(column_name);
        } else {
            table.indexes.push(DbIndexMeta {
                name: index_name,
                columns: vec![column_name],
                unique,
            });
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_tables(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<Vec<String>, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = omnipanel_db::connect(&params)
        .await
        .map_err(err_msg)?;
    driver.list_tables().await.map_err(err_msg)
}

#[tauri::command]
pub async fn db_preview_table(
    connection: DbConnectionConfig,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<TableInfo, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    let result = driver
        .preview(&table, limit as i64, offset as i64)
        .await
        .map_err(err_msg)?;
    Ok(to_table_info(table, result))
}

#[tauri::command]
pub async fn db_count_table(
    connection: DbConnectionConfig,
    table: String,
) -> Result<i64, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    driver.count(&table).await.map_err(err_msg)
}

/// 执行任意 SQL（SELECT 返回行集，DML 返回影响行数）。高风险写操作由前端经执行引擎确认后调用。
#[tauri::command]
pub async fn db_execute_query(
    connection: DbConnectionConfig,
    sql: String,
) -> Result<QueryResult, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    driver.execute(&sql).await.map_err(err_msg)
}

/// 将列式 QueryResult 转换为前端预览用的 TableInfo（行为 列名→值 的 map）。
fn to_table_info(name: String, result: QueryResult) -> TableInfo {
    let rows = result
        .rows
        .into_iter()
        .map(|record| {
            result
                .columns
                .iter()
                .cloned()
                .zip(record)
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .collect();
    TableInfo {
        name,
        rows,
        columns: result.columns,
    }
}
