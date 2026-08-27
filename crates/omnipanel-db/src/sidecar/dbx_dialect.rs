//! DBX Agent 方言：ready 横幅、协议 v2、方法名与结果形状适配。

use serde::Deserialize;
use serde_json::{Value, json};

use crate::sidecar::protocol::{ColumnInfo, HandshakeResult, RpcResponse};
use crate::{DbParams, QueryResult};

#[derive(Debug, Clone)]
pub enum AgentDialect {
    OmniV1,
    DbxV2 { session_id: String },
}

impl AgentDialect {
    pub fn from_handshake(handshake: &HandshakeResult, session_id: String) -> Self {
        let v2 = handshake.protocol_version >= 2
            || handshake
                .capabilities
                .iter()
                .any(|cap| cap == "multi_session");
        if v2 {
            Self::DbxV2 { session_id }
        } else {
            Self::OmniV1
        }
    }

    pub fn outbound_method<'a>(&self, method: &'a str) -> &'a str {
        match self {
            Self::OmniV1 => method,
            Self::DbxV2 { .. } => match method {
                "connect" => "open_session",
                "disconnect" => "close_session",
                "execute" => "execute_query",
                "version" => "validate_connection",
                "describe_table" => "get_columns",
                "show_create_table" => "get_table_ddl",
                other => other,
            },
        }
    }

    pub fn prepare_params(&self, method: &str, mut params: Value) -> Value {
        let Self::DbxV2 { session_id } = self else {
            return params;
        };
        if !params.is_object() {
            params = json!({});
        }
        if let Some(obj) = params.as_object_mut() {
            if method != "handshake" && method != "open_session" && method != "shutdown" {
                obj.entry("agentSessionId")
                    .or_insert_with(|| Value::String(session_id.clone()));
            }
            if let Some(user) = obj.get("user").cloned() {
                obj.entry("username").or_insert(user);
            }
            if matches!(
                method,
                "describe_table" | "get_columns" | "show_create_table" | "get_table_ddl"
            ) {
                if let Some(table) = obj.get("table").cloned() {
                    obj.entry("tableName").or_insert(table.clone());
                    obj.entry("table_name").or_insert(table);
                }
            }
        }
        params
    }

    pub fn is_dbx_v2(&self) -> bool {
        matches!(self, Self::DbxV2 { .. })
    }
}

/// 跳过 DBX native agent 启动时的 `{"ready":true}` 等非 JSON-RPC 行。
pub fn parse_jsonrpc_line(line: &str) -> Option<RpcResponse> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    if value.get("jsonrpc").is_none() {
        return None;
    }
    serde_json::from_value(value).ok()
}

pub fn dbx_open_session_params(params: &DbParams, session_id: &str) -> Value {
    let kind = dialect_kind(&params.db_type);
    let mut obj = json!({
        "agentSessionId": session_id,
        "db_type": params.db_type,
        "host": params.host,
        "port": params.port,
        "user": params.user,
        "username": params.user,
        "password": params.password,
        "database": params.database,
        "ssl": params.ssl,
    });
    if let Some(map) = obj.as_object_mut() {
        if kind == "oracle" {
            if !params.sid.trim().is_empty() {
                map.insert("sid".into(), Value::String(params.sid.clone()));
            }
            map.insert("serviceName".into(), Value::String(params.database.clone()));
            map.insert("sysdba".into(), Value::Bool(params.sysdba));
        }
        if kind == "sqlserver" || kind == "neo4j" {
            map.insert("encrypt".into(), Value::Bool(params.ssl));
            map.insert("trustServerCertificate".into(), Value::Bool(true));
        }
        if kind == "cassandra" && !params.database.trim().is_empty() {
            map.insert("keyspace".into(), Value::String(params.database.clone()));
        }
        if kind == "dameng" && !params.database.trim().is_empty() {
            map.insert("schema".into(), Value::String(params.database.clone()));
        }
    }
    obj
}

pub fn dbx_schema_params(database: &str) -> Value {
    let mut obj = json!({});
    if !database.trim().is_empty() {
        obj["schema"] = Value::String(database.trim().to_string());
    }
    obj
}

pub fn dbx_table_params(database: &str, table: &str) -> Value {
    let mut obj = dbx_schema_params(database);
    if let Some(map) = obj.as_object_mut() {
        map.insert("table".into(), Value::String(table.to_string()));
        map.insert("tableName".into(), Value::String(table.to_string()));
        map.insert("table_name".into(), Value::String(table.to_string()));
    }
    obj
}

pub fn decode_table_names(value: Value) -> Result<Vec<String>, String> {
    match value {
        Value::Array(items) => Ok(items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(name) => Some(name),
                Value::Object(obj) => obj.get("name").and_then(Value::as_str).map(str::to_string),
                _ => None,
            })
            .collect()),
        other => Err(format!("list_tables 返回非法: {other}")),
    }
}

#[derive(Debug, Deserialize)]
struct DbxColumn {
    name: String,
    #[serde(default, alias = "type", alias = "data_type")]
    data_type: String,
}

pub fn decode_columns(value: Value) -> Result<Vec<ColumnInfo>, String> {
    if let Ok(cols) = serde_json::from_value::<Vec<ColumnInfo>>(value.clone()) {
        return Ok(cols);
    }
    let cols: Vec<DbxColumn> =
        serde_json::from_value(value).map_err(|e| format!("get_columns 返回非法: {e}"))?;
    Ok(cols
        .into_iter()
        .map(|col| ColumnInfo {
            name: col.name,
            column_type: col.data_type,
        })
        .collect())
}

pub fn decode_dbx_query_result(value: Value) -> Result<QueryResult, String> {
    #[derive(Deserialize)]
    struct DbxQuery {
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        rows: Vec<Vec<Value>>,
        #[serde(default, alias = "affected_rows", alias = "rowsAffected")]
        rows_affected: u64,
    }
    let parsed: DbxQuery =
        serde_json::from_value(value).map_err(|e| format!("QueryResult 非法: {e}"))?;
    Ok(QueryResult {
        columns: parsed.columns,
        rows: parsed.rows,
        rows_affected: parsed.rows_affected,
    })
}

pub fn decode_version(value: Value) -> String {
    match value {
        Value::String(s) => s,
        Value::Object(obj) if obj.get("ok").and_then(Value::as_bool) == Some(true) => {
            "connected".into()
        }
        other => other
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| other.to_string()),
    }
}

pub fn decode_ddl(value: Value) -> String {
    match value {
        Value::String(s) => s,
        Value::Object(obj) => obj
            .get("ddl")
            .or_else(|| obj.get("sql"))
            .or_else(|| obj.get("create"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| Value::Object(obj).to_string()),
        other => other.as_str().unwrap_or_default().to_string(),
    }
}

fn dialect_kind(db_type: &str) -> &'static str {
    match db_type.to_ascii_lowercase().as_str() {
        "oracle" | "orcl" => "oracle",
        "dameng" | "dm" => "dameng",
        "sqlserver" | "mssql" | "sql server" => "sqlserver",
        "cassandra" => "cassandra",
        "neo4j" => "neo4j",
        "db2" => "db2",
        "hive" | "spark" => "hive",
        "firebird" => "firebird",
        _ => "limit",
    }
}

fn sql_ident(name: &str) -> String {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if ok {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn cypher_label(name: &str) -> String {
    let ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        name.to_string()
    } else {
        format!("`{}`", name.replace('`', "``"))
    }
}

pub fn preview_sql(
    db_type: &str,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    where_clause: Option<&str>,
) -> String {
    let limit = limit.max(0);
    let offset = offset.max(0);
    match dialect_kind(db_type) {
        "neo4j" => {
            let mut sql = format!("MATCH (n:{})", cypher_label(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            sql.push_str(&format!(" RETURN n SKIP {offset} LIMIT {limit}"));
            sql
        }
        "cassandra" => {
            let mut sql = format!("SELECT * FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            sql.push_str(&format!(" LIMIT {limit}"));
            sql
        }
        "sqlserver" => {
            let mut sql = format!("SELECT * FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            let order = order_by
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("(SELECT NULL)");
            sql.push_str(&format!(
                " ORDER BY {order} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            ));
            sql
        }
        "oracle" | "db2" | "dameng" => {
            let mut sql = format!("SELECT * FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            if let Some(order) = order_by.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" ORDER BY ");
                sql.push_str(order);
            }
            sql.push_str(&format!(
                " OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            ));
            sql
        }
        "hive" => {
            let mut sql = format!("SELECT * FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            if let Some(order) = order_by.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" ORDER BY ");
                sql.push_str(order);
            }
            sql.push_str(&format!(" LIMIT {limit}"));
            sql
        }
        "firebird" => {
            let mut sql = format!("SELECT * FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            if let Some(order) = order_by.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" ORDER BY ");
                sql.push_str(order);
            }
            let start = offset + 1;
            let end = start + limit - 1;
            sql.push_str(&format!(" ROWS {start} TO {end}"));
            sql
        }
        _ => {
            let mut sql = format!("SELECT * FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            if let Some(order) = order_by.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" ORDER BY ");
                sql.push_str(order);
            }
            sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
            sql
        }
    }
}

pub fn count_sql(db_type: &str, table: &str, where_clause: Option<&str>) -> String {
    match dialect_kind(db_type) {
        "neo4j" => {
            let mut sql = format!("MATCH (n:{})", cypher_label(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            sql.push_str(" RETURN count(n)");
            sql
        }
        _ => {
            let mut sql = format!("SELECT COUNT(*) FROM {}", sql_ident(table));
            if let Some(clause) = where_clause.map(str::trim).filter(|s| !s.is_empty()) {
                sql.push_str(" WHERE ");
                sql.push_str(clause);
            }
            sql
        }
    }
}

pub fn extract_count(result: &QueryResult) -> i64 {
    let Some(cell) = result.rows.first().and_then(|row| row.first()) else {
        return result.rows_affected as i64;
    };
    match cell {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|v| v as i64))
            .unwrap_or(0),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_ready_banner() {
        assert!(parse_jsonrpc_line(r#"{"ready":true}"#).is_none());
        let rpc = parse_jsonrpc_line(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2,"capabilities":["multi_session"]}}"#,
        )
        .expect("jsonrpc");
        assert!(rpc.error.is_none());
    }

    #[test]
    fn table_names_from_objects() {
        let value = json!([{"name":"EMP","table_type":"TABLE"}, {"name":"DEPT"}]);
        assert_eq!(decode_table_names(value).unwrap(), vec!["EMP", "DEPT"]);
    }

    #[test]
    fn query_result_accepts_affected_rows() {
        let value = json!({
            "columns": ["X"],
            "rows": [[1]],
            "affected_rows": 0,
            "execution_time_ms": 3
        });
        let result = decode_dbx_query_result(value).unwrap();
        assert_eq!(result.columns, vec!["X"]);
        assert_eq!(result.rows_affected, 0);
    }

    #[test]
    fn handshake_without_engine_is_v2() {
        let hs: HandshakeResult = serde_json::from_value(json!({
            "protocolVersion": 2,
            "agentProtocolVersion": 2,
            "capabilities": ["connect", "multi_session"]
        }))
        .unwrap();
        assert_eq!(hs.protocol_version, 2);
        assert!(hs.engine.is_empty());
        assert!(AgentDialect::from_handshake(&hs, "s1".into()).is_dbx_v2());
    }

    #[test]
    fn preview_sql_keeps_simple_idents() {
        assert_eq!(
            preview_sql("mysql", "EMP", 50, 0, None, Some("DEPTNO = 10")),
            "SELECT * FROM EMP WHERE DEPTNO = 10 LIMIT 50 OFFSET 0"
        );
        assert_eq!(count_sql("mysql", "EMP", None), "SELECT COUNT(*) FROM EMP");
    }

    #[test]
    fn preview_sql_oracle_and_sqlserver_use_fetch() {
        let sql = preview_sql("oracle", "EMP", 50, 10, Some("EMPNO"), None);
        assert!(sql.contains("OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY"));
        assert!(!sql.contains("LIMIT"));
        let dameng = preview_sql("dameng", "SYSDBA.T", 20, 0, None, None);
        assert!(dameng.contains("OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY"));
        let mssql = preview_sql("sqlserver", "dbo.t", 20, 0, None, None);
        assert!(mssql.contains("ORDER BY (SELECT NULL)"));
        assert!(mssql.contains("FETCH NEXT 20 ROWS ONLY"));
    }

    #[test]
    fn preview_sql_cassandra_skips_offset() {
        let sql = preview_sql("cassandra", "ks.t", 50, 10, None, None);
        assert_eq!(sql, "SELECT * FROM ks.t LIMIT 50");
    }

    #[test]
    fn preview_sql_neo4j_uses_cypher() {
        assert_eq!(
            preview_sql("neo4j", "Person", 20, 5, None, None),
            "MATCH (n:Person) RETURN n SKIP 5 LIMIT 20"
        );
        assert_eq!(
            count_sql("neo4j", "Person", None),
            "MATCH (n:Person) RETURN count(n)"
        );
    }

    #[test]
    fn preview_sql_hive_and_firebird() {
        assert_eq!(
            preview_sql("hive", "logs", 50, 10, None, None),
            "SELECT * FROM logs LIMIT 50"
        );
        assert_eq!(
            preview_sql("firebird", "EMPLOYEE", 20, 10, None, None),
            "SELECT * FROM EMPLOYEE ROWS 11 TO 30"
        );
    }

    #[test]
    fn cassandra_open_session_and_schema_params() {
        let params = DbParams {
            db_type: "cassandra".into(),
            host: "127.0.0.1".into(),
            port: 9042,
            user: String::new(),
            password: String::new(),
            database: "omni_test".into(),
            ssl: false,
            sid: String::new(),
            sysdba: false,
        };
        let open = dbx_open_session_params(&params, "s1");
        assert_eq!(open["keyspace"], "omni_test");
        assert_eq!(open["database"], "omni_test");
        let tables = dbx_schema_params("omni_test");
        assert_eq!(tables["schema"], "omni_test");
        let cols = dbx_table_params("omni_test", "person");
        assert_eq!(cols["schema"], "omni_test");
        assert_eq!(cols["table"], "person");
        assert_eq!(cols["tableName"], "person");
    }
}
