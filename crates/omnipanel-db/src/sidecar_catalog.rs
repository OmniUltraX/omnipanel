//! Sidecar 引擎按方言家族拉库统计 / 表详情 / 用户。
//! 只负责家族判定、SQL 与结果解析，不连库。

use crate::QueryResult;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogFamily {
    OracleLike,
    PostgresLike,
    MysqlLike,
    HiveLike,
    GenericSql,
    NonSql,
}

pub fn catalog_family(db_type: &str) -> CatalogFamily {
    let engine = db_type.trim().to_ascii_lowercase();
    match engine.as_str() {
        "oracle" | "orcl" | "dameng" | "dm" | "db2" | "oceanbase-oracle" | "gbase8s" | "oscar"
        | "informix" | "iris" | "yashandb" | "xugu" => CatalogFamily::OracleLike,
        "kingbase" | "kingbasees" | "vastbase" | "highgo" | "uxdb" | "cockroachdb" | "gaussdb"
        | "opengauss" => CatalogFamily::PostgresLike,
        "oceanbase" | "goldendb" | "gbase8a" | "tidb" | "mariadb" => CatalogFamily::MysqlLike,
        "hive" | "spark" | "databricks" | "kylin" => CatalogFamily::HiveLike,
        "neo4j" | "cassandra" | "mongodb" | "mongo" | "redis" | "qdrant" => CatalogFamily::NonSql,
        _ => CatalogFamily::GenericSql,
    }
}

pub fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn charset_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::OracleLike => &[
            "SELECT VALUE AS CHARSET FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER = 'NLS_CHARACTERSET'",
            "SELECT SF_GET_PARA_VALUE(2, 'CHARSET') AS CHARSET FROM DUAL",
        ],
        CatalogFamily::PostgresLike => &[
            "SELECT pg_encoding_to_char(encoding) AS CHARSET FROM pg_database WHERE datname = current_database()",
        ],
        _ => &[],
    }
}

pub fn collation_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::OracleLike => {
            &["SELECT VALUE AS COLLATION FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER = 'NLS_SORT'"]
        }
        CatalogFamily::PostgresLike => {
            &["SELECT datcollate AS COLLATION FROM pg_database WHERE datname = current_database()"]
        }
        _ => &[],
    }
}

pub fn schema_stats_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::OracleLike => &[
            "SELECT u.USERNAME AS NAME, \
             (SELECT COUNT(*) FROM ALL_TABLES t WHERE t.OWNER = u.USERNAME) AS TABLE_COUNT, \
             (SELECT SUM(NUM_ROWS) FROM ALL_TABLES t WHERE t.OWNER = u.USERNAME) AS ROWS_ESTIMATE \
             FROM ALL_USERS u ORDER BY u.USERNAME",
            "SELECT USERNAME AS NAME FROM ALL_USERS ORDER BY USERNAME",
        ],
        CatalogFamily::PostgresLike => &["SELECT d.datname AS NAME, \
               pg_encoding_to_char(d.encoding) AS CHARSET, \
               d.datcollate AS COLLATION, \
               pg_database_size(d.datname) AS SIZE_BYTES \
             FROM pg_database d \
             WHERE NOT d.datistemplate \
             ORDER BY d.datname"],
        CatalogFamily::MysqlLike => &["SELECT s.SCHEMA_NAME AS NAME, \
               s.DEFAULT_CHARACTER_SET_NAME AS CHARSET, \
               s.DEFAULT_COLLATION_NAME AS COLLATION, \
               COUNT(t.TABLE_NAME) AS TABLE_COUNT, \
               COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS SIZE_BYTES, \
               COALESCE(SUM(t.TABLE_ROWS), 0) AS ROWS_ESTIMATE \
             FROM information_schema.SCHEMATA s \
             LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME \
             GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME \
             ORDER BY s.SCHEMA_NAME"],
        CatalogFamily::HiveLike => &["SHOW DATABASES"],
        _ => &[],
    }
}

pub fn schema_size_sql(family: CatalogFamily) -> Option<&'static str> {
    match family {
        CatalogFamily::OracleLike => {
            Some("SELECT OWNER AS NAME, SUM(BYTES) AS SIZE_BYTES FROM DBA_SEGMENTS GROUP BY OWNER")
        }
        _ => None,
    }
}

pub fn table_details_sqls(family: CatalogFamily, schema: &str) -> Vec<String> {
    let schema_lit = sql_literal(schema);
    match family {
        CatalogFamily::OracleLike => vec![
            format!(
                "SELECT t.TABLE_NAME AS NAME, t.NUM_ROWS AS ROW_COUNT, \
                 t.TABLESPACE_NAME AS ENGINE, c.COMMENTS AS TABLE_COMMENT, \
                 t.LAST_ANALYZED AS UPDATE_TIME \
                 FROM ALL_TABLES t \
                 LEFT JOIN ALL_TAB_COMMENTS c \
                   ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME \
                 WHERE t.OWNER = {schema_lit} \
                 ORDER BY t.TABLE_NAME"
            ),
            format!(
                "SELECT TABLE_NAME AS NAME, NUM_ROWS AS ROW_COUNT, TABLESPACE_NAME AS ENGINE \
                 FROM ALL_TABLES WHERE OWNER = {schema_lit} ORDER BY TABLE_NAME"
            ),
        ],
        CatalogFamily::PostgresLike => vec![
            "SELECT c.relname AS NAME, c.reltuples AS ROW_COUNT, \
             pg_relation_size(c.oid) AS DATA_LENGTH, \
             obj_description(c.oid, 'pg_class') AS TABLE_COMMENT \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') \
             ORDER BY c.relname"
                .to_string(),
            "SELECT c.relname AS NAME, c.reltuples AS ROW_COUNT \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
             ORDER BY c.relname"
                .to_string(),
        ],
        CatalogFamily::MysqlLike => vec![format!(
            "SELECT TABLE_NAME AS NAME, TABLE_ROWS AS ROW_COUNT, DATA_LENGTH, \
             ENGINE, TABLE_COMMENT, TABLE_COLLATION AS COLLATION \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = {schema_lit} AND TABLE_TYPE = 'BASE TABLE' \
             ORDER BY TABLE_NAME"
        )],
        CatalogFamily::HiveLike => vec![
            format!("SHOW TABLES IN {schema}"),
            "SHOW TABLES".to_string(),
        ],
        CatalogFamily::GenericSql => vec![
            "SELECT TABLE_NAME AS NAME FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_TYPE IN ('BASE TABLE', 'TABLE') \
             ORDER BY TABLE_NAME"
                .to_string(),
        ],
        _ => vec![],
    }
}

pub fn table_size_sql(family: CatalogFamily, schema: &str) -> Option<String> {
    if family != CatalogFamily::OracleLike {
        return None;
    }
    let schema = sql_literal(schema);
    Some(format!(
        "SELECT SEGMENT_NAME AS NAME, SUM(BYTES) AS DATA_LENGTH \
         FROM DBA_SEGMENTS \
         WHERE OWNER = {schema} AND SEGMENT_TYPE IN ('TABLE', 'TABLE PARTITION') \
         GROUP BY SEGMENT_NAME"
    ))
}

pub fn users_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::OracleLike => &[
            "SELECT USERNAME AS NAME, ACCOUNT_STATUS FROM DBA_USERS ORDER BY USERNAME",
            "SELECT USERNAME AS NAME FROM ALL_USERS ORDER BY USERNAME",
        ],
        CatalogFamily::PostgresLike => &[
            "SELECT rolname AS NAME, rolcanlogin, rolsuper, rolcreatedb FROM pg_catalog.pg_roles ORDER BY rolname",
        ],
        CatalogFamily::MysqlLike => &[
            "SELECT User AS NAME, Host, Super_priv, Create_priv FROM mysql.user ORDER BY User, Host",
        ],
        _ => &[],
    }
}

pub fn process_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::PostgresLike => &[
            "SELECT pid AS Id, usename AS \"User\", client_addr AS Host, datname AS db, state AS State, query AS Query, \
             EXTRACT(EPOCH FROM now() - query_start)::bigint AS Time \
             FROM pg_stat_activity WHERE datname IS NOT NULL ORDER BY Time DESC",
        ],
        CatalogFamily::OracleLike => &[
            "SELECT SID AS Id, USERNAME AS \"User\", MACHINE AS Host, SCHEMANAME AS db, STATUS AS State, \
             SQL_ID AS Query, LAST_CALL_ET AS Time FROM v$session WHERE USERNAME IS NOT NULL",
            "SELECT SESS_ID AS Id, USER_NAME AS \"User\", CLNT_HOST AS Host, CURR_SCH AS db, STATE AS State, \
             SQL_TEXT AS Query FROM V$SESSIONS WHERE USER_NAME IS NOT NULL",
        ],
        CatalogFamily::MysqlLike => &["SHOW FULL PROCESSLIST"],
        _ => &[],
    }
}

pub fn settings_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::PostgresLike => {
            &["SELECT name, setting, source, context FROM pg_settings ORDER BY name"]
        }
        CatalogFamily::OracleLike => &[
            "SELECT NAME, VALUE, ISDEFAULT AS source, DESCRIPTION AS context FROM v$parameter ORDER BY NAME",
            "SELECT NAME, VALUE FROM V$PARAMETER ORDER BY NAME",
        ],
        CatalogFamily::MysqlLike => &["SHOW VARIABLES"],
        _ => &[],
    }
}

pub fn slow_query_sqls(family: CatalogFamily) -> &'static [&'static str] {
    match family {
        CatalogFamily::PostgresLike => &[
            "SELECT query, calls, total_exec_time, mean_exec_time, rows \
             FROM pg_stat_statements ORDER BY total_exec_time DESC NULLS LAST LIMIT 100",
            "SELECT query, calls, total_time, mean_time, rows \
             FROM pg_stat_statements ORDER BY total_time DESC NULLS LAST LIMIT 100",
        ],
        CatalogFamily::OracleLike => &[
            "SELECT SQL_ID, SQL_TEXT, ELAPSED_TIME/1000000 AS elapsed_sec, EXECUTIONS, DISK_READS \
             FROM v$sql WHERE ROWNUM <= 100 ORDER BY ELAPSED_TIME DESC",
            "SELECT SQL_TEXT, EXECUTIONS, ELAPSED_TIME FROM V$SQL WHERE ROWNUM <= 100",
        ],
        CatalogFamily::MysqlLike => &["SELECT TRUNCATE(QUERY_TIME, 3) AS query_time, SQL_TEXT \
             FROM mysql.slow_log ORDER BY start_time DESC LIMIT 100"],
        _ => &[],
    }
}

pub const SQLSERVER_PROCESS_SQL: &str = "SELECT session_id AS Id, login_name AS \"User\", host_name AS Host, \
    DB_NAME(database_id) AS db, status AS State, \
    DATEDIFF(second, login_time, GETDATE()) AS Time \
    FROM sys.dm_exec_sessions WHERE is_user_process = 1 ORDER BY Time DESC";

pub const SQLSERVER_SETTINGS_SQL: &str = "SELECT name, CAST(value AS nvarchar(max)) AS setting, \
    CAST(value_in_use AS nvarchar(max)) AS source, description AS context \
    FROM sys.configurations ORDER BY name";

pub const SQLSERVER_SLOW_QUERY_SQL: &str = "SELECT TOP 100 \
    qs.total_elapsed_time / 1000 AS elapsed_ms, qs.execution_count, \
    SUBSTRING(qt.text, 1, 4000) AS query \
    FROM sys.dm_exec_query_stats qs \
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt \
    ORDER BY qs.total_elapsed_time DESC";

pub const SQLSERVER_USERS_SQL: &str = "SELECT name AS NAME, is_disabled, type_desc \
    FROM sys.server_principals \
    WHERE type IN ('S', 'U', 'G') AND name NOT LIKE '##%' \
    ORDER BY name";

pub fn process_list_sqls(family: CatalogFamily) -> &'static [&'static str] {
    process_sqls(family)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogDatabaseRow {
    pub name: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub table_count: Option<i32>,
    pub size_bytes: Option<f64>,
    pub rows_estimate: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogTableRow {
    pub name: String,
    pub row_count: Option<i64>,
    pub data_length: Option<i64>,
    pub engine: Option<String>,
    pub comment: Option<String>,
    pub collation: Option<String>,
    pub update_time: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogUserRow {
    pub name: String,
    pub host: Option<String>,
    pub can_login: bool,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub is_role: bool,
    pub account_locked: Option<bool>,
}

pub fn parse_scalar(result: &QueryResult) -> Option<String> {
    let row = result.rows.first()?;
    nonempty(cell_at(row, 0))
}

pub fn parse_schema_stats(result: &QueryResult) -> Vec<CatalogDatabaseRow> {
    let name_i = col_index(
        result,
        &[
            "NAME",
            "USERNAME",
            "SCHEMA_NAME",
            "DATNAME",
            "DATABASE",
            "DATABASE_NAME",
        ],
    );
    let charset_i = col_index(result, &["CHARSET", "ENCODING"]);
    let collation_i = col_index(result, &["COLLATION", "DATCOLLATE"]);
    let count_i = col_index(result, &["TABLE_COUNT"]);
    let rows_i = col_index(result, &["ROWS_ESTIMATE", "NUM_ROWS"]);
    let size_i = col_index(result, &["SIZE_BYTES", "BYTES"]);
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = first_nonempty_cell(row, name_i)?;
            Some(CatalogDatabaseRow {
                name,
                charset: nonempty(cell_named(row, charset_i)),
                collation: nonempty(cell_named(row, collation_i)),
                table_count: parse_i32(cell_named(row, count_i)),
                size_bytes: parse_f64(cell_named(row, size_i)).filter(|v| *v >= 0.0),
                rows_estimate: parse_f64(cell_named(row, rows_i)).filter(|v| *v >= 0.0),
            })
        })
        .collect()
}

pub fn parse_name_size_map(result: &QueryResult) -> Vec<(String, f64)> {
    let name_i = col_index(result, &["NAME", "OWNER", "SEGMENT_NAME"]);
    let size_i = col_index(result, &["SIZE_BYTES", "DATA_LENGTH", "BYTES"]);
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = first_nonempty_cell(row, name_i)?;
            let size = parse_f64(cell_named(row, size_i)).filter(|v| *v >= 0.0)?;
            Some((name, size))
        })
        .collect()
}

pub fn parse_table_details(result: &QueryResult) -> Vec<CatalogTableRow> {
    let name_i = col_index(result, &["NAME", "TABLE_NAME", "TAB_NAME", "RELNAME"]);
    let rows_i = col_index(
        result,
        &["ROW_COUNT", "NUM_ROWS", "TABLE_ROWS", "RELTUPLES"],
    );
    let size_i = col_index(result, &["DATA_LENGTH", "BYTES"]);
    let engine_i = col_index(result, &["ENGINE", "TABLESPACE_NAME"]);
    let comment_i = col_index(result, &["TABLE_COMMENT", "COMMENTS", "COMMENT"]);
    let collation_i = col_index(result, &["COLLATION", "TABLE_COLLATION"]);
    let updated_i = col_index(result, &["UPDATE_TIME", "LAST_ANALYZED"]);
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = first_nonempty_cell(row, name_i)?;
            Some(CatalogTableRow {
                name,
                row_count: parse_i64(cell_named(row, rows_i)).filter(|v| *v >= 0),
                data_length: parse_i64(cell_named(row, size_i)).filter(|v| *v >= 0),
                engine: nonempty(cell_named(row, engine_i)),
                comment: nonempty(cell_named(row, comment_i)),
                collation: nonempty(cell_named(row, collation_i)),
                update_time: nonempty(cell_named(row, updated_i)),
            })
        })
        .collect()
}

pub fn merge_table_sizes(tables: &mut [CatalogTableRow], sizes: &[(String, f64)]) {
    for (name, bytes) in sizes {
        if let Some(row) = tables
            .iter_mut()
            .find(|t| t.name.eq_ignore_ascii_case(name))
        {
            row.data_length = Some(*bytes as i64);
        }
    }
}

pub fn merge_schema_sizes(schemas: &mut [CatalogDatabaseRow], sizes: &[(String, f64)]) {
    for (name, bytes) in sizes {
        if let Some(row) = schemas
            .iter_mut()
            .find(|s| s.name.eq_ignore_ascii_case(name))
        {
            row.size_bytes = Some(*bytes);
        }
    }
}

pub fn parse_users(result: &QueryResult, family: CatalogFamily) -> Vec<CatalogUserRow> {
    match family {
        CatalogFamily::PostgresLike => parse_pg_users(result),
        CatalogFamily::MysqlLike => parse_mysql_users(result),
        _ => parse_oracle_users(result),
    }
}

fn parse_oracle_users(result: &QueryResult) -> Vec<CatalogUserRow> {
    let name_i = col_index(result, &["NAME", "USERNAME"]);
    let status_i = col_index(result, &["ACCOUNT_STATUS", "STATUS"]);
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = first_nonempty_cell(row, name_i)?;
            let status = cell_named(row, status_i).to_ascii_uppercase();
            let locked = if status.is_empty() {
                None
            } else {
                Some(status.contains("LOCK"))
            };
            let upper = name.to_ascii_uppercase();
            let is_superuser = matches!(
                upper.as_str(),
                "SYSDBA" | "SYS" | "SYSTEM" | "SYSAUDITOR" | "SYSSSO" | "DB2INST1" | "DB2ADMIN"
            );
            Some(CatalogUserRow {
                name,
                host: None,
                can_login: true,
                is_superuser,
                can_create_db: is_superuser,
                is_role: false,
                account_locked: locked,
            })
        })
        .collect()
}

fn parse_pg_users(result: &QueryResult) -> Vec<CatalogUserRow> {
    let name_i = col_index(result, &["NAME", "ROLNAME"]);
    let login_i = col_index(result, &["ROLCANLOGIN"]);
    let super_i = col_index(result, &["ROLSUPER"]);
    let createdb_i = col_index(result, &["ROLCREATEDB"]);
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = first_nonempty_cell(row, name_i)?;
            let can_login = parse_bool(cell_named(row, login_i)).unwrap_or(true);
            Some(CatalogUserRow {
                name,
                host: None,
                can_login,
                is_superuser: parse_bool(cell_named(row, super_i)).unwrap_or(false),
                can_create_db: parse_bool(cell_named(row, createdb_i)).unwrap_or(false),
                is_role: !can_login,
                account_locked: None,
            })
        })
        .collect()
}

fn parse_mysql_users(result: &QueryResult) -> Vec<CatalogUserRow> {
    let name_i = col_index(result, &["NAME", "USER"]);
    let host_i = col_index(result, &["HOST"]);
    let super_i = col_index(result, &["SUPER_PRIV"]);
    let createdb_i = col_index(result, &["CREATE_PRIV"]);
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = first_nonempty_cell(row, name_i)?;
            let host = nonempty(cell_named(row, host_i));
            let yn = |value: String| {
                value.eq_ignore_ascii_case("Y")
                    || value == "1"
                    || parse_bool(value).unwrap_or(false)
            };
            Some(CatalogUserRow {
                is_superuser: yn(cell_named(row, super_i)),
                can_create_db: yn(cell_named(row, createdb_i)),
                name,
                host,
                can_login: true,
                is_role: false,
                account_locked: None,
            })
        })
        .collect()
}

fn col_index(result: &QueryResult, names: &[&str]) -> Option<usize> {
    result.columns.iter().position(|col| {
        let upper = col.trim().to_ascii_uppercase();
        names.iter().any(|name| upper == *name)
    })
}

fn first_nonempty_cell(row: &[Value], named: Option<usize>) -> Option<String> {
    if let Some(value) = nonempty(cell_named(row, named)) {
        return Some(value);
    }
    row.iter().find_map(|cell| nonempty(value_text(cell)))
}

fn cell_named(row: &[Value], index: Option<usize>) -> String {
    index
        .and_then(|i| row.get(i))
        .map(value_text)
        .unwrap_or_default()
}

fn cell_at(row: &[Value], index: usize) -> String {
    row.get(index).map(value_text).unwrap_or_default()
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string().trim_matches('"').to_string(),
    }
}

fn nonempty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "-" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_i32(value: String) -> Option<i32> {
    nonempty(value)?.replace(',', "").parse().ok()
}

fn parse_i64(value: String) -> Option<i64> {
    let raw = nonempty(value)?;
    if let Ok(v) = raw.replace(',', "").parse::<i64>() {
        return Some(v);
    }
    raw.parse::<f64>().ok().map(|v| v as i64)
}

fn parse_f64(value: String) -> Option<f64> {
    nonempty(value)?.replace(',', "").parse().ok()
}

fn parse_bool(value: String) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "t" | "true" | "1" | "y" | "yes" => Some(true),
        "f" | "false" | "0" | "n" | "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(columns: &[&str], rows: Vec<Vec<Value>>) -> QueryResult {
        QueryResult {
            columns: columns.iter().map(|s| (*s).to_string()).collect(),
            rows,
            rows_affected: 0,
        }
    }

    #[test]
    fn families_cover_sidecar_engines() {
        assert_eq!(catalog_family("dameng"), CatalogFamily::OracleLike);
        assert_eq!(catalog_family("oracle"), CatalogFamily::OracleLike);
        assert_eq!(catalog_family("db2"), CatalogFamily::OracleLike);
        assert_eq!(catalog_family("kingbase"), CatalogFamily::PostgresLike);
        assert_eq!(catalog_family("highgo"), CatalogFamily::PostgresLike);
        assert_eq!(catalog_family("oceanbase"), CatalogFamily::MysqlLike);
        assert_eq!(catalog_family("hive"), CatalogFamily::HiveLike);
        assert_eq!(catalog_family("firebird"), CatalogFamily::GenericSql);
        assert_eq!(catalog_family("neo4j"), CatalogFamily::NonSql);
        assert!(!process_sqls(CatalogFamily::PostgresLike).is_empty());
        assert!(!settings_sqls(CatalogFamily::OracleLike).is_empty());
        assert!(!slow_query_sqls(CatalogFamily::PostgresLike).is_empty());
    }

    #[test]
    fn parses_schema_stats_by_alias() {
        let parsed = parse_schema_stats(&result(
            &["name", "table_count", "rows_estimate"],
            vec![vec![json!("SYSDBA"), json!(12), json!(100)]],
        ));
        assert_eq!(parsed[0].name, "SYSDBA");
        assert_eq!(parsed[0].table_count, Some(12));
        assert_eq!(parsed[0].rows_estimate, Some(100.0));
    }

    #[test]
    fn hive_show_databases_uses_first_cell() {
        let parsed = parse_schema_stats(&result(
            &["database_name"],
            vec![vec![json!("default")], vec![json!("logs")]],
        ));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "default");
    }

    #[test]
    fn parses_table_details_and_merges_size() {
        let mut tables = parse_table_details(&result(
            &["NAME", "ROW_COUNT", "ENGINE", "TABLE_COMMENT"],
            vec![vec![
                json!("EMP"),
                json!(20),
                json!("MAIN"),
                json!("employees"),
            ]],
        ));
        merge_table_sizes(&mut tables, &[("emp".into(), 4096.0)]);
        assert_eq!(tables[0].row_count, Some(20));
        assert_eq!(tables[0].data_length, Some(4096));
        assert_eq!(tables[0].comment.as_deref(), Some("employees"));
    }

    #[test]
    fn parses_pg_and_oracle_users() {
        let oracle = parse_users(
            &result(
                &["USERNAME", "ACCOUNT_STATUS"],
                vec![vec![json!("SYSDBA"), json!("OPEN")]],
            ),
            CatalogFamily::OracleLike,
        );
        assert!(oracle[0].is_superuser);

        let pg = parse_users(
            &result(
                &["rolname", "rolcanlogin", "rolsuper", "rolcreatedb"],
                vec![vec![json!("app"), json!(true), json!(false), json!(true)]],
            ),
            CatalogFamily::PostgresLike,
        );
        assert!(pg[0].can_create_db);
        assert!(!pg[0].is_superuser);
    }

    #[test]
    fn process_and_slow_query_sqls_cover_families() {
        assert!(!process_list_sqls(CatalogFamily::PostgresLike).is_empty());
        assert!(!process_list_sqls(CatalogFamily::OracleLike).is_empty());
        assert!(!settings_sqls(CatalogFamily::PostgresLike).is_empty());
        assert!(slow_query_sqls(CatalogFamily::PostgresLike)[0].contains("pg_stat_statements"));
        assert!(
            slow_query_sqls(CatalogFamily::OracleLike)[0]
                .to_ascii_uppercase()
                .contains("SQL")
        );
        assert!(!SQLSERVER_PROCESS_SQL.is_empty());
        assert!(SQLSERVER_SETTINGS_SQL.contains("sys.configurations"));
        assert!(SQLSERVER_SLOW_QUERY_SQL.contains("dm_exec_query_stats"));
    }
}
