use std::collections::HashMap;

use omnipanel_db::{
    connect, db_introspect_table, db_table_ddl, DbDriver, DbParams, DbTableSchema, QueryResult,
};
use omnipanel_error::OmniError;
use omnipanel_store::{fill_db_password_from_vault, DbConnectionConfig};
use serde::{Deserialize, Serialize};

/// 前端预览表结构（列名 → 值的 map 行集）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub columns: Vec<String>,
}

fn err_msg(e: OmniError) -> String {
    e.user_message()
}

/// 将 IPC 连接配置转换为 omnipanel-db 的领域连接参数。
pub fn to_params(c: &DbConnectionConfig) -> DbParams {
    let mut c = c.clone();
    fill_db_password_from_vault(&mut c);
    DbParams {
        db_type: c.db_type.clone(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        password: c.password.clone(),
        database: c.database.clone(),
        ssl: c.ssl,
        sid: c.sid.clone(),
        sysdba: c.sysdba,
    }
}

pub fn with_schema(c: &DbConnectionConfig, schema: Option<String>) -> DbParams {
    let mut params = to_params(c);
    if let Some(s) = schema.filter(|name| !name.trim().is_empty()) {
        params.database = s;
    }
    params
}

/// 打开可复用的数据库驱动（供后台同步任务分页读取，避免每页新建连接池）。
pub async fn open_db_driver(c: &DbConnectionConfig) -> Result<Box<dyn DbDriver>, String> {
    let mut c = c.clone();
    fill_db_password_from_vault(&mut c);
    connect(&to_params(&c)).await.map_err(err_msg)
}

pub fn query_result_to_row_maps(
    result: QueryResult,
) -> Vec<HashMap<String, serde_json::Value>> {
    let columns = result.columns;
    result
        .rows
        .into_iter()
        .map(|record| {
            columns
                .iter()
                .cloned()
                .zip(record)
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .collect()
}

/// 将列式 QueryResult 转换为前端预览用的 TableInfo。
pub fn to_table_info(name: String, result: QueryResult) -> TableInfo {
    let columns = result.columns.clone();
    let rows = query_result_to_row_maps(result);
    TableInfo {
        name,
        rows,
        columns,
    }
}

pub async fn db_list_tables(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<Vec<String>, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await.map_err(err_msg)?;
    driver.list_tables().await.map_err(err_msg)
}

pub async fn db_preview_table(
    connection: DbConnectionConfig,
    table: String,
    limit: u32,
    offset: u32,
    order_by: Option<String>,
    where_clause: Option<String>,
) -> Result<TableInfo, String> {
    let driver = connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    let result = driver
        .preview(
            &table,
            limit as i64,
            offset as i64,
            order_by.as_deref(),
            where_clause.as_deref(),
        )
        .await
        .map_err(err_msg)?;
    Ok(to_table_info(table, result))
}

pub async fn db_count_table(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
    where_clause: Option<String>,
) -> Result<f64, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await.map_err(err_msg)?;
    driver
        .count(table.trim(), where_clause.as_deref())
        .await
        .map_err(err_msg)
        .map(|n| n as f64)
}

pub async fn db_run_sql(
    connection: DbConnectionConfig,
    schema: Option<String>,
    sql: String,
) -> Result<u64, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await.map_err(err_msg)?;
    driver
        .execute(&sql)
        .await
        .map_err(err_msg)
        .map(|result| result.rows_affected)
}

pub async fn db_introspect_table_op(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DbTableSchema, String> {
    db_introspect_table(connection, schema, table).await
}

pub async fn db_table_ddl_op(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<String, String> {
    db_table_ddl(connection, schema, table).await
}
