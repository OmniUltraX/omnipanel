//! EngineSession：宿主 ↔ sidecar 的 JSON-RPC 2.0（stdin/stdout 一行一条）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{DbParams, QueryResult};

pub const PROTOCOL_VERSION: u32 = 1;
pub const CLICKHOUSE_SIDECAR_BIN: &str = "omnipanel-engine-clickhouse";

/// 把 DBX / JDBC 风格方法名归一到 EngineSession 规范名。未知名称原样返回。
pub fn canonical_rpc_method(method: &str) -> &str {
    match method {
        "executeQuery" => "execute",
        "listTables" => "list_tables",
        "getColumns" => "describe_table",
        "getTableDdl" => "show_create_table",
        "listDatabases" => "list_databases",
        "testConnection" | "test_connection" => "version",
        "listSchemas" => "list_schemas",
        other => other,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl RpcRequest {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(RpcError {
                code: -32000,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResult {
    #[serde(default, alias = "protocol_version")]
    pub protocol_version: u32,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
    pub ssl: bool,
}

impl From<&DbParams> for ConnectParams {
    fn from(params: &DbParams) -> Self {
        Self {
            db_type: params.db_type.clone(),
            host: params.host.clone(),
            port: params.port,
            user: params.user.clone(),
            password: params.password.clone(),
            database: params.database.clone(),
            ssl: params.ssl,
        }
    }
}

impl From<ConnectParams> for DbParams {
    fn from(params: ConnectParams) -> Self {
        Self {
            db_type: params.db_type,
            host: params.host,
            port: params.port,
            user: params.user,
            password: params.password,
            database: params.database,
            ssl: params.ssl,
            sid: String::new(),
            sysdba: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteParams {
    pub sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewParams {
    pub table: String,
    pub limit: i64,
    pub offset: i64,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default)]
    pub where_clause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountParams {
    pub table: String,
    #[serde(default)]
    pub where_clause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableParams {
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseParams {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
}

pub fn encode_query_result(result: &QueryResult) -> Value {
    serde_json::to_value(result).unwrap_or(Value::Null)
}

pub fn decode_query_result(value: Value) -> Result<QueryResult, String> {
    serde_json::from_value(value).map_err(|e| format!("QueryResult 非法: {e}"))
}

#[cfg(test)]
mod tests {
    use super::canonical_rpc_method;

    #[test]
    fn maps_dbx_aliases_to_engine_session() {
        assert_eq!(canonical_rpc_method("executeQuery"), "execute");
        assert_eq!(canonical_rpc_method("listTables"), "list_tables");
        assert_eq!(canonical_rpc_method("getColumns"), "describe_table");
        assert_eq!(canonical_rpc_method("getTableDdl"), "show_create_table");
        assert_eq!(canonical_rpc_method("listDatabases"), "list_databases");
        assert_eq!(canonical_rpc_method("listSchemas"), "list_schemas");
        assert_eq!(canonical_rpc_method("testConnection"), "version");
        assert_eq!(canonical_rpc_method("execute"), "execute");
    }
}
