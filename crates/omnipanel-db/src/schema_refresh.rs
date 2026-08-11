//! Schema 树节点刷新：连接 / 库 / 表 / 用户等懒加载片段（桌面与 Web 共用）。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::introspect::{
    db_introspect_table, db_list_connection_users, db_list_databases, list_database_objects_shallow,
    DbRoutineMeta, DbTableSchema, DbUserMeta,
};
use crate::{redis_list_databases_with_key_counts, DbParams};
use omnipanel_store::DbConnectionConfig;

fn to_params(c: &DbConnectionConfig) -> DbParams {
    let mut c = c.clone();
    omnipanel_store::fill_db_password_from_vault(&mut c);
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

fn err_msg(e: omnipanel_error::OmniError) -> String {
    e.user_message()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheDatabasePayload {
    pub name: String,
    pub tables: Vec<DbTableSchema>,
    #[serde(default)]
    pub views: Vec<DbTableSchema>,
    #[serde(default)]
    pub routines: Vec<DbRoutineMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_error: Option<String>,
    /// 连接浅刷新为 false；库对象名列表已拉取为 true（列/索引仍可按表懒加载）。
    #[serde(default)]
    pub objects_loaded: bool,
    /// Redis：`INFO keyspace` 的 keys 数；其它引擎忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub key_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaConnectionRefreshPayload {
    pub databases: Vec<SchemaCacheDatabasePayload>,
    #[serde(default)]
    pub users: Vec<DbUserMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTableRefreshPayload {
    pub database_name: String,
    pub object_kind: String,
    pub table: DbTableSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "scope")]
pub enum SchemaNodeRefreshResult {
    Connection(SchemaConnectionRefreshPayload),
    Database(SchemaCacheDatabasePayload),
    Table(SchemaTableRefreshPayload),
    Users { users: Vec<DbUserMeta> },
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNodeRefreshArgs {
    pub connection: DbConnectionConfig,
    pub node_kind: String,
    pub node_id: String,
}

fn parse_conn_db_from_rest(rest: &str) -> Option<(String, String)> {
    let colon_indices: Vec<usize> = rest.match_indices(':').map(|(i, _)| i).collect();
    if colon_indices.is_empty() {
        return None;
    }
    let conn_id = rest[..colon_indices[0]].to_string();
    let db_name = rest[colon_indices[0] + 1..].to_string();
    if conn_id.is_empty() || db_name.is_empty() {
        return None;
    }
    Some((conn_id, db_name))
}

fn parse_object_node_id(id: &str, prefix: &str) -> Option<(String, String, String)> {
    let rest = id.strip_prefix(prefix)?;
    let colon_indices: Vec<usize> = rest.match_indices(':').map(|(i, _)| i).collect();
    if colon_indices.len() < 2 {
        return None;
    }
    let conn_id = rest[..colon_indices[0]].to_string();
    let last = *colon_indices.last()?;
    let db_name = rest[colon_indices[0] + 1..last].to_string();
    let mut object_name = rest[last + 1..].to_string();
    if let Some(pos) = object_name.find(":col:") {
        object_name.truncate(pos);
    } else if let Some(pos) = object_name.find(":idx:") {
        object_name.truncate(pos);
    }
    if conn_id.is_empty() || db_name.is_empty() || object_name.is_empty() {
        return None;
    }
    Some((conn_id, db_name, object_name))
}

fn table_key_from_details_folder(id: &str) -> Option<String> {
    id.strip_suffix(":cols")
        .or_else(|| id.strip_suffix(":idxs"))
        .map(str::to_string)
}

async fn refresh_database_payload(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<SchemaCacheDatabasePayload, String> {
    list_database_objects_shallow(connection, db_name).await
}

/// 连接级浅刷新：仅库名 + 用户，不拉取各库表结构（避免打开连接时主线程被巨型 JSON 卡死）。
pub async fn refresh_connection_payload(
    connection: &DbConnectionConfig,
) -> Result<SchemaConnectionRefreshPayload, String> {
    if connection.db_type.to_lowercase() == "redis" {
        let infos = redis_list_databases_with_key_counts(&to_params(connection), &connection.database)
            .await
            .map_err(err_msg)?;
        let databases = infos
            .into_iter()
            .map(|info| SchemaCacheDatabasePayload {
                name: info.name,
                tables: Vec::new(),
                views: Vec::new(),
                routines: Vec::new(),
                load_error: None,
                objects_loaded: true,
                key_count: Some(info.key_count as i64),
            })
            .collect();
        return Ok(SchemaConnectionRefreshPayload {
            databases,
            users: Vec::new(),
        });
    }

    let db_names = db_list_databases(connection.clone()).await?;
    let databases = db_names
        .into_iter()
        .map(|name| SchemaCacheDatabasePayload {
            name,
            tables: Vec::new(),
            views: Vec::new(),
            routines: Vec::new(),
            load_error: None,
            objects_loaded: false,
            key_count: None,
        })
        .collect();
    let users = db_list_connection_users(connection.clone())
        .await
        .unwrap_or_default();
    Ok(SchemaConnectionRefreshPayload { databases, users })
}

async fn refresh_table_payload(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
    object_kind: &str,
) -> Result<SchemaTableRefreshPayload, String> {
    let table = db_introspect_table(
        connection.clone(),
        Some(db_name.to_string()),
        table_name.to_string(),
    )
    .await?;
    Ok(SchemaTableRefreshPayload {
        database_name: db_name.to_string(),
        object_kind: object_kind.to_string(),
        table,
    })
}

/// 按 Schema 树节点类型刷新缓存片段（连接 / 库 / 表 / 用户等）。
pub async fn db_refresh_schema_node(
    args: SchemaNodeRefreshArgs,
) -> Result<SchemaNodeRefreshResult, String> {
    let kind = args.node_kind.as_str();
    let id = args.node_id.as_str();
    let connection = &args.connection;

    match kind {
        "connection" => Ok(SchemaNodeRefreshResult::Connection(
            refresh_connection_payload(connection).await?,
        )),
        "database" => {
            let (_, db_name) = parse_conn_db_from_rest(id.strip_prefix("db:").ok_or("无效的数据库节点")?)
                .ok_or_else(|| "无法解析数据库节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Database(
                refresh_database_payload(connection, &db_name).await?,
            ))
        }
        "folder" => {
            if let Some(conn_id) = id.strip_prefix("databases:") {
                if conn_id != connection.id {
                    return Err("连接 id 与节点不匹配".to_string());
                }
                return Ok(SchemaNodeRefreshResult::Connection(
                    refresh_connection_payload(connection).await?,
                ));
            }
            if let Some(conn_id) = id.strip_prefix("users:") {
                if conn_id != connection.id {
                    return Err("连接 id 与节点不匹配".to_string());
                }
                return Ok(SchemaNodeRefreshResult::Users {
                    users: db_list_connection_users(connection.clone()).await?,
                });
            }
            if let Some(rest) = id
                .strip_prefix("tbls:")
                .or_else(|| id.strip_prefix("views:"))
                .or_else(|| id.strip_prefix("other:"))
            {
                let (_, db_name) = parse_conn_db_from_rest(rest)
                    .ok_or_else(|| "无法解析文件夹节点".to_string())?;
                return Ok(SchemaNodeRefreshResult::Database(
                    refresh_database_payload(connection, &db_name).await?,
                ));
            }
            if let Some(table_key) = table_key_from_details_folder(id) {
                let (_, db_name, table_name) = parse_object_node_id(&table_key, "tbl:")
                    .ok_or_else(|| "无法解析表字段/索引文件夹".to_string())?;
                return Ok(SchemaNodeRefreshResult::Table(
                    refresh_table_payload(connection, &db_name, &table_name, "table").await?,
                ));
            }
            Err(format!("不支持的文件夹节点：{id}"))
        }
        "table" => {
            let (_, db_name, table_name) = parse_object_node_id(id, "tbl:")
                .ok_or_else(|| "无法解析表节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Table(
                refresh_table_payload(connection, &db_name, &table_name, "table").await?,
            ))
        }
        "view" => {
            let (_, db_name, view_name) = parse_object_node_id(id, "view:")
                .ok_or_else(|| "无法解析视图节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Table(
                refresh_table_payload(connection, &db_name, &view_name, "view").await?,
            ))
        }
        "routine" => {
            let (_, db_name, _) = parse_object_node_id(id, "routine:")
                .ok_or_else(|| "无法解析例程节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Database(
                refresh_database_payload(connection, &db_name).await?,
            ))
        }
        "user" => Ok(SchemaNodeRefreshResult::Users {
            users: db_list_connection_users(connection.clone()).await?,
        }),
        "column" | "index" => {
            let (_, db_name, table_name) = parse_object_node_id(id, "tbl:")
                .ok_or_else(|| "无法解析列/索引节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Table(
                refresh_table_payload(connection, &db_name, &table_name, "table").await?,
            ))
        }
        "group" => Err("分组节点请在前端刷新其下连接".to_string()),
        _ => Err(format!("不支持的节点类型：{kind}")),
    }
}
