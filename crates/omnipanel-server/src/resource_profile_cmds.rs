//! 资源档案采集与观测 diff（Web 端，对齐桌面 `resource_profile.rs`）。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_db::{DbDriver, DbParams, connect as db_connect};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use omnipanel_store::{DbConnectionConfig, ResourceObservation, fill_db_password_from_vault};
use serde::Serialize;
use serde_json::{Value, json};

use crate::monitoring::ensure_ssh_session;
use crate::state::ServerState;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn obs_id(resource_type: &str) -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("obs_{resource_type}_{t}")
}

fn to_db_params(c: &DbConnectionConfig) -> DbParams {
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

/// 采集结果：成功保存的观测种类列表 + 失败子任务的错误信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshotResult {
    pub saved_kinds: Vec<String>,
    pub errors: Vec<String>,
}

/// 计算某资源某 kind 最近两次观测的 diff。
pub async fn resource_compute_observation_diff(
    state: &ServerState,
    resource_type: String,
    resource_id: String,
    observation_kind: String,
) -> Result<Value, OmniError> {
    let storage = state.storage.lock().await;
    storage.compute_observation_diff(&resource_type, &resource_id, &observation_kind)
}

/// 采集 SSH 主机快照：hardware + services + topology。
pub async fn resource_collect_ssh_snapshot(
    state: &ServerState,
    resource_id: String,
) -> Result<ResourceSnapshotResult, OmniError> {
    let (session, _) = ensure_ssh_session(state, &resource_id).await?;
    let mut saved_kinds: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    match collect_ssh_hardware(&session).await {
        Ok(payload) => {
            if save_observation(state, "ssh", &resource_id, "hardware", payload).await? {
                saved_kinds.push("hardware".to_string());
            }
        }
        Err(e) => errors.push(format!("hardware: {}", e.user_message())),
    }

    match collect_ssh_services(&session).await {
        Ok(payload) => {
            if save_observation(state, "ssh", &resource_id, "services", payload).await? {
                saved_kinds.push("services".to_string());
            }
        }
        Err(e) => errors.push(format!("services: {}", e.user_message())),
    }

    match collect_ssh_topology(&session).await {
        Ok(payload) => {
            if save_observation(state, "ssh", &resource_id, "topology", payload).await? {
                saved_kinds.push("topology".to_string());
            }
        }
        Err(e) => errors.push(format!("topology: {}", e.user_message())),
    }

    Ok(ResourceSnapshotResult {
        saved_kinds,
        errors,
    })
}

/// 采集数据库快照：overview + schema_summary + users + table_relations。
pub async fn resource_collect_database_snapshot(
    state: &ServerState,
    connection_name: String,
) -> Result<ResourceSnapshotResult, OmniError> {
    let list = state.db_connections.list()?;
    let summary = list
        .iter()
        .find(|c| c.name == connection_name)
        .ok_or_else(|| {
            OmniError::new(
                ErrorCode::NotFound,
                format!("数据库连接不存在：{connection_name}"),
            )
        })?;
    if !summary.enabled {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("连接已禁用：{connection_name}"),
        ));
    }

    let conn = state
        .db_connections
        .get_with_secret(&summary.id)?
        .ok_or_else(|| {
            OmniError::new(
                ErrorCode::NotFound,
                format!("数据库连接不存在：{connection_name}"),
            )
        })?;

    let params = to_db_params(&conn);
    let driver = db_connect(&params).await?;

    let mut saved_kinds: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    match collect_db_overview(&driver, &conn.db_type).await {
        Ok(payload) => {
            if save_observation(state, "database", &connection_name, "overview", payload).await? {
                saved_kinds.push("overview".to_string());
            }
        }
        Err(e) => errors.push(format!("overview: {}", e.user_message())),
    }

    match collect_db_schema_summary(&driver, &conn.db_type, &conn.database).await {
        Ok(payload) => {
            if save_observation(
                state,
                "database",
                &connection_name,
                "schema_summary",
                payload,
            )
            .await?
            {
                saved_kinds.push("schema_summary".to_string());
            }
        }
        Err(e) => errors.push(format!("schema_summary: {}", e.user_message())),
    }

    match collect_db_users(&driver, &conn.db_type).await {
        Ok(payload) => {
            if save_observation(state, "database", &connection_name, "users", payload).await? {
                saved_kinds.push("users".to_string());
            }
        }
        Err(e) => errors.push(format!("users: {}", e.user_message())),
    }

    match collect_db_table_relations(&driver, &conn.db_type).await {
        Ok(payload) => {
            if save_observation(
                state,
                "database",
                &connection_name,
                "table_relations",
                payload,
            )
            .await?
            {
                saved_kinds.push("table_relations".to_string());
            }
        }
        Err(e) => errors.push(format!("table_relations: {}", e.user_message())),
    }

    Ok(ResourceSnapshotResult {
        saved_kinds,
        errors,
    })
}

async fn save_observation(
    state: &ServerState,
    resource_type: &str,
    resource_id: &str,
    observation_kind: &str,
    payload: Value,
) -> Result<bool, OmniError> {
    let obs = ResourceObservation {
        id: obs_id(resource_type),
        resource_type: resource_type.to_string(),
        resource_id: resource_id.to_string(),
        observation_kind: observation_kind.to_string(),
        payload,
        observed_at: now_millis(),
        observer: "auto".to_string(),
    };
    let storage = state.storage.lock().await;
    storage.save_resource_observation(&obs)?;
    Ok(true)
}

async fn collect_ssh_hardware(session: &Arc<SshSession>) -> OmniResult<Value> {
    let os_info = session.exec_capture("uname -a").await?;
    let nproc = session.exec_capture("nproc").await?;
    let meminfo = session.exec_capture("free -b").await?;
    let disk = session.exec_capture("df -B1").await?;

    let cpu_cores: u32 = nproc.stdout.trim().parse::<u32>().unwrap_or(0);

    Ok(json!({
        "os": os_info.stdout.trim(),
        "cpu_cores": cpu_cores,
        "memory_raw": meminfo.stdout,
        "disk_raw": disk.stdout,
    }))
}

async fn collect_ssh_services(session: &Arc<SshSession>) -> OmniResult<Value> {
    let out = session
        .exec_capture(
            "systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null \
             | awk '{print $1}' | head -50",
        )
        .await?;

    let services: Vec<String> = out
        .stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(json!({ "running": services }))
}

async fn collect_ssh_topology(session: &Arc<SshSession>) -> OmniResult<Value> {
    let ip_addr = session
        .exec_capture("ip -brief addr 2>/dev/null || ifconfig 2>/dev/null")
        .await?;
    let listening = session
        .exec_capture("ss -tlnp 2>/dev/null | head -30 || netstat -tlnp 2>/dev/null | head -30")
        .await?;

    Ok(json!({
        "interfaces": ip_addr.stdout,
        "listening_ports": listening.stdout,
    }))
}

async fn collect_db_overview(driver: &Box<dyn DbDriver>, db_type: &str) -> OmniResult<Value> {
    let version = driver.version().await.unwrap_or_default();

    let uptime_sql = match db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            "SHOW GLOBAL STATUS WHERE Variable_name IN \
             ('Uptime', 'Threads_connected', 'Max_used_connections')"
        }
        "postgres" | "postgresql" | "pg" => {
            "SELECT 'Uptime' AS Variable_name, \
                    EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint::text AS Value \
             UNION ALL \
             SELECT 'Threads_connected', count(*)::text FROM pg_stat_activity"
        }
        _ => "",
    };

    let mut status = serde_json::Map::new();
    if !uptime_sql.is_empty() {
        if let Ok(res) = driver.execute(uptime_sql).await {
            for row in &res.rows {
                if row.len() >= 2 {
                    let k = row[0].as_str().unwrap_or("").to_string();
                    let v = row[1].as_str().unwrap_or("").to_string();
                    if !k.is_empty() {
                        status.insert(k, Value::String(v));
                    }
                }
            }
        }
    }

    Ok(json!({
        "version": version,
        "status": Value::Object(status),
    }))
}

async fn collect_db_schema_summary(
    driver: &Box<dyn DbDriver>,
    db_type: &str,
    database: &str,
) -> OmniResult<Value> {
    let tables = driver.list_tables().await.unwrap_or_default();
    let table_count = tables.len();

    let size_sql = match db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => format!(
            "SELECT table_schema, COUNT(*) AS table_count, \
                    ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb \
             FROM information_schema.tables \
             WHERE table_schema = '{}' \
             GROUP BY table_schema",
            database.replace('\'', "\\'")
        ),
        "postgres" | "postgresql" | "pg" => "SELECT current_database() AS table_schema, \
                    COUNT(*) AS table_count, \
                    ROUND(pg_database_size(current_database()) / 1024 / 1024, 2) AS size_mb \
             FROM information_schema.tables WHERE table_schema = 'public'"
            .to_string(),
        _ => String::new(),
    };

    let mut size_info = Value::Null;
    if !size_sql.is_empty() {
        if let Ok(res) = driver.execute(&size_sql).await {
            if let Some(row) = res.rows.first() {
                size_info = json!({
                    "schema": row.get(0).cloned().unwrap_or(Value::Null),
                    "table_count": row.get(1).cloned().unwrap_or(Value::Null),
                    "size_mb": row.get(2).cloned().unwrap_or(Value::Null),
                });
            }
        }
    }

    Ok(json!({
        "tables_sample": tables.iter().take(50).cloned().collect::<Vec<_>>(),
        "table_count": table_count,
        "size": size_info,
    }))
}

async fn collect_db_users(driver: &Box<dyn DbDriver>, db_type: &str) -> OmniResult<Value> {
    let users_sql = match db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => "SELECT user, host FROM mysql.user ORDER BY user",
        "postgres" | "postgresql" | "pg" => {
            "SELECT rolname, '' AS host FROM pg_roles \
             WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname"
        }
        _ => "",
    };

    let mut users: Vec<Value> = Vec::new();
    if !users_sql.is_empty() {
        if let Ok(res) = driver.execute(users_sql).await {
            for row in &res.rows {
                if row.len() >= 2 {
                    users.push(json!({
                        "user": row[0],
                        "host": row[1],
                    }));
                }
            }
        }
    }

    Ok(json!({ "users": users }))
}

async fn collect_db_table_relations(
    driver: &Box<dyn DbDriver>,
    db_type: &str,
) -> OmniResult<Value> {
    let (sql_col, query) = match db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => (
            "DIGEST_TEXT",
            "SELECT DIGEST_TEXT, COUNT_STAR AS exec_count \
             FROM performance_schema.events_statements_summary_by_digest \
             WHERE DIGEST_TEXT IS NOT NULL AND DIGEST_TEXT != '' \
             ORDER BY COUNT_STAR DESC LIMIT 200",
        ),
        "postgres" | "postgresql" | "pg" => (
            "query",
            "SELECT query, calls AS exec_count \
             FROM pg_stat_statements \
             WHERE query IS NOT NULL AND query !~* '^(BEGIN|COMMIT|ROLLBACK|SET|SHOW)' \
             ORDER BY calls DESC LIMIT 200",
        ),
        _ => {
            return Ok(json!({
                "source": "unsupported",
                "pairs": [],
                "join_types": [],
                "table_hit_counts": {},
                "sql_sample_count": 0,
                "note": "该数据库类型不支持表关系采集",
            }));
        }
    };

    let res = driver.execute(query).await?;
    let mut pairs: Vec<[String; 2]> = Vec::new();
    let mut join_types: Vec<String> = Vec::new();
    let mut table_hit_counts: std::collections::BTreeMap<String, u32> =
        std::collections::BTreeMap::new();
    let mut sql_sample_count: u32 = 0;

    for row in &res.rows {
        let sql_text = row
            .first()
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if sql_text.is_empty() {
            continue;
        }
        sql_sample_count += 1;
        let tables = extract_table_names(&sql_text);
        for t in &tables {
            *table_hit_counts.entry(t.clone()).or_insert(0) += 1;
        }
        let joins = extract_join_clauses(&sql_text);
        for j in &joins {
            if !j.join_type.is_empty() && !join_types.contains(&j.join_type) {
                join_types.push(j.join_type.clone());
            }
            if !j.left_table.is_empty() && !j.right_table.is_empty() {
                let pair = [j.left_table.clone(), j.right_table.clone()];
                if !pairs.contains(&pair) {
                    pairs.push(pair);
                }
            }
        }
        if tables.len() >= 2 && joins.is_empty() {
            for i in 0..tables.len() {
                for j in (i + 1)..tables.len() {
                    let pair = [tables[i].clone(), tables[j].clone()];
                    if !pairs.contains(&pair) {
                        pairs.push(pair);
                    }
                }
            }
        }
    }

    pairs.truncate(100);
    join_types.truncate(20);

    Ok(json!({
        "source": sql_col.to_lowercase(),
        "pairs": pairs.into_iter().map(|p| json!([p[0], p[1]])).collect::<Vec<_>>(),
        "join_types": join_types,
        "table_hit_counts": table_hit_counts.into_iter().collect::<std::collections::BTreeMap<_, _>>(),
        "sql_sample_count": sql_sample_count,
    }))
}

fn extract_table_names(sql: &str) -> Vec<String> {
    let mut tables: Vec<String> = Vec::new();
    let patterns: &[&str] = &[
        r#"(?i)\bFROM\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
        r#"(?i)\bJOIN\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
        r#"(?i)\bUPDATE\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
        r#"(?i)\bINTO\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
    ];
    for pat in patterns {
        if let Ok(re) = regex::Regex::new(pat) {
            for cap in re.captures_iter(sql) {
                if let Some(m) = cap.get(1) {
                    let name = m
                        .as_str()
                        .trim_matches(|c| c == '`' || c == '"' || c == ']');
                    let upper = name.to_uppercase();
                    if !matches!(
                        upper.as_str(),
                        "SELECT"
                            | "WHERE"
                            | "GROUP"
                            | "ORDER"
                            | "LIMIT"
                            | "SET"
                            | "VALUES"
                            | "ON"
                            | "AS"
                            | "JOIN"
                            | "LEFT"
                            | "RIGHT"
                            | "INNER"
                            | "OUTER"
                            | "FROM"
                            | "UPDATE"
                            | "INTO"
                            | "DUAL"
                    ) && !name.is_empty()
                    {
                        if !tables.contains(&name.to_string()) {
                            tables.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    tables
}

struct JoinClause {
    join_type: String,
    left_table: String,
    right_table: String,
}

fn extract_join_clauses(sql: &str) -> Vec<JoinClause> {
    let mut result: Vec<JoinClause> = Vec::new();
    let re = regex::Regex::new(
        r#"(?i)\b((?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN)\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?[^;]*?\bON\b\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?\."#,
    );
    if let Ok(re) = re {
        for cap in re.captures_iter(sql) {
            let join_kw = cap
                .get(1)
                .map(|m| m.as_str().trim().to_uppercase())
                .unwrap_or_default();
            let right_table = cap
                .get(2)
                .map(|m| {
                    m.as_str()
                        .trim_matches(|c| c == '`' || c == '"' || c == ']')
                        .to_string()
                })
                .unwrap_or_default();
            let left_table = cap
                .get(3)
                .map(|m| {
                    m.as_str()
                        .trim_matches(|c| c == '`' || c == '"' || c == ']')
                        .to_string()
                })
                .unwrap_or_default();
            if !left_table.is_empty() && !right_table.is_empty() {
                result.push(JoinClause {
                    join_type: join_kw,
                    left_table,
                    right_table,
                });
            }
        }
    }
    result
}
