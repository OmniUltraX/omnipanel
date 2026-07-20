//! 资源档案：Tauri 命令层 + 采集器。
//!
//! - 查询类命令（list / get / find_similar / list_knowledge / delete_observations）：
//!   薄包装 `Storage` 方法，供前端 UI 使用。
//! - 采集器：在 SSH 连接 / DB 连接首次建立或手动触发时，拉取关键观测并写入
//!   `resource_observations` 表（observer="auto"）。
//! - 手动录入：`resource_save_observation` 供 UI 添加笔记类观测（observer="manual"）。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_db::{connect as db_connect, DbDriver, DbParams};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use omnipanel_store::{
    DbConnectionConfig, KnowledgeEntry, ResourceObservation, ResourceProfileSummary,
    load_database_connections,
};
use serde::Serialize;
use serde_json::{json, Value};
use specta::Type;
use tauri::State;

use crate::state::AppState;

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

/// 采集结果：成功保存的观测种类列表 + 失败子任务的错误信息。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshotResult {
    /// 本次成功保存的 observation_kind 列表（如 ["hardware", "services", "topology"]）。
    pub saved_kinds: Vec<String>,
    /// 失败的子任务错误描述（采集过程中某项失败不影响其他项）。
    pub errors: Vec<String>,
}

// ── 查询类命令 ───────────────────────────────────────────────────────

/// 列出所有有观测记录的资源摘要（可按 resource_type 过滤）。
#[tauri::command]
#[specta::specta]
pub async fn resource_list_profiles(
    state: State<'_, AppState>,
    resource_type: Option<String>,
) -> Result<Vec<ResourceProfileSummary>, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .list_resources_with_profiles(resource_type.as_deref())
        .map_err(Into::into)
}

/// 获取资源最新档案：每类 observation_kind 取最新一条，组装为 JSON 对象。
#[tauri::command]
#[specta::specta]
pub async fn resource_get_profile(
    state: State<'_, AppState>,
    resource_type: String,
    resource_id: String,
) -> Result<Option<Value>, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .get_latest_resource_profile(&resource_type, &resource_id)
        .map_err(Into::into)
}

/// 查找相似资源（基于指纹匹配，按相似度排序）。
#[tauri::command]
#[specta::specta]
pub async fn resource_find_similar(
    state: State<'_, AppState>,
    resource_type: String,
    resource_id: String,
    limit: Option<usize>,
) -> Result<Vec<ResourceProfileSummary>, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .find_similar_resources(&resource_type, &resource_id, limit.unwrap_or(5))
        .map_err(Into::into)
}

/// 清空资源的全部观测记录（重置档案）。
#[tauri::command]
#[specta::specta]
pub async fn resource_delete_observations(
    state: State<'_, AppState>,
    resource_type: String,
    resource_id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage
        .delete_resource_observations(&resource_type, &resource_id)
        .map_err(Into::into)
}

/// 列出资源关联的 knowledge 条目（按更新时间倒序）。
#[tauri::command]
#[specta::specta]
pub async fn resource_list_knowledge(
    state: State<'_, AppState>,
    resource_type: String,
    resource_id: String,
) -> Result<Vec<KnowledgeEntry>, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .list_knowledge_for_resource(&resource_type, &resource_id)
        .map_err(Into::into)
}

/// Phase 5 子任务 3：计算某资源某 kind 最近两次观测的 diff。
/// 供前端 UI 在快照面板上展示"自上次以来发生了什么变化"。
#[tauri::command]
#[specta::specta]
pub async fn resource_compute_observation_diff(
    state: State<'_, AppState>,
    resource_type: String,
    resource_id: String,
    observation_kind: String,
) -> Result<Value, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .compute_observation_diff(&resource_type, &resource_id, &observation_kind)
        .map_err(Into::into)
}

/// 手动追加一条资源观测（observer=manual；如 kind=note 用于运维笔记）。
#[tauri::command]
#[specta::specta]
pub async fn resource_save_observation(
    state: State<'_, AppState>,
    resource_type: String,
    resource_id: String,
    observation_kind: String,
    payload: Value,
    observer: Option<String>,
) -> Result<String, OmniError> {
    if !matches!(resource_type.as_str(), "ssh" | "database" | "docker" | "files") {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("resource_type 非法：{resource_type}"),
        ));
    }
    if !payload.is_object() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "payload 必须是 JSON 对象",
        ));
    }
    let obs = ResourceObservation {
        id: obs_id(&resource_type),
        resource_type: resource_type.clone(),
        resource_id: resource_id.clone(),
        observation_kind,
        payload,
        observed_at: now_millis(),
        observer: observer.unwrap_or_else(|| "manual".to_string()),
    };
    let id = obs.id.clone();
    let storage = state.storage.lock().await;
    storage.save_resource_observation(&obs).map_err(OmniError::from)?;
    Ok(id)
}

// ── 采集器 ───────────────────────────────────────────────────────────

/// 采集 SSH 主机快照：hardware + services + topology 三类观测。
///
/// 依赖 SSH 连接池中已建立的会话（前端需先调用 `ssh_connect_connection` 建立会话）。
/// 任一子任务失败不影响其他子任务，错误汇总到 `errors` 字段。
#[tauri::command]
#[specta::specta]
pub async fn resource_collect_ssh_snapshot(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<ResourceSnapshotResult, OmniError> {
    let session = state.ssh_pool.ensure_session(&resource_id).await?;
    let mut saved_kinds: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // hardware: OS / CPU / 内存 / 磁盘
    match collect_ssh_hardware(&session).await {
        Ok(payload) => {
            if save_observation(&state, "ssh", &resource_id, "hardware", payload).await? {
                saved_kinds.push("hardware".to_string());
            }
        }
        Err(e) => errors.push(format!("hardware: {}", e.user_message())),
    }

    // services: 运行中的 systemd 服务
    match collect_ssh_services(&session).await {
        Ok(payload) => {
            if save_observation(&state, "ssh", &resource_id, "services", payload).await? {
                saved_kinds.push("services".to_string());
            }
        }
        Err(e) => errors.push(format!("services: {}", e.user_message())),
    }

    // topology: 网卡 + 监听端口
    match collect_ssh_topology(&session).await {
        Ok(payload) => {
            if save_observation(&state, "ssh", &resource_id, "topology", payload).await? {
                saved_kinds.push("topology".to_string());
            }
        }
        Err(e) => errors.push(format!("topology: {}", e.user_message())),
    }

    Ok(ResourceSnapshotResult { saved_kinds, errors })
}

/// 采集数据库快照：overview + schema_summary + users 三类观测。
///
/// 直接通过 `omnipanel-db::connect` 建立一次性连接，不依赖 AppState 中的连接池
/// （避免与正在执行的查询争抢资源；采集本身频率极低）。
#[tauri::command]
#[specta::specta]
pub async fn resource_collect_database_snapshot(
    state: State<'_, AppState>,
    connection_name: String,
) -> Result<ResourceSnapshotResult, OmniError> {
    let connections = load_database_connections().map_err(OmniError::from)?;
    let conn = connections
        .iter()
        .find(|c| c.name == connection_name)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("数据库连接不存在：{connection_name}")))?
        .clone();
    if !conn.enabled {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("连接已禁用：{connection_name}"),
        ));
    }

    let params = to_db_params(&conn);
    let driver = db_connect(&params).await?;

    let mut saved_kinds: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // overview: version + uptime + connections
    match collect_db_overview(&driver, &conn.db_type).await {
        Ok(payload) => {
            if save_observation(&state, "database", &connection_name, "overview", payload).await? {
                saved_kinds.push("overview".to_string());
            }
        }
        Err(e) => errors.push(format!("overview: {}", e.user_message())),
    }

    // schema_summary: 表数量 + 总大小 + 前 50 张表名
    match collect_db_schema_summary(&driver, &conn.db_type, &conn.database).await {
        Ok(payload) => {
            if save_observation(&state, "database", &connection_name, "schema_summary", payload)
                .await?
            {
                saved_kinds.push("schema_summary".to_string());
            }
        }
        Err(e) => errors.push(format!("schema_summary: {}", e.user_message())),
    }

    // users: 用户列表（MySQL/MariaDB/PostgreSQL）
    match collect_db_users(&driver, &conn.db_type).await {
        Ok(payload) => {
            if save_observation(&state, "database", &connection_name, "users", payload).await? {
                saved_kinds.push("users".to_string());
            }
        }
        Err(e) => errors.push(format!("users: {}", e.user_message())),
    }

    // table_relations: 从 performance_schema / pg_stat_statements 提取 SQL 文本，
    // 用轻量正则识别 FROM / JOIN / UPDATE / INTO 表名，构造表关系对。
    // 这是 Phase 5 子任务 1：表关系推断采集器。
    match collect_db_table_relations(&driver, &conn.db_type).await {
        Ok(payload) => {
            if save_observation(&state, "database", &connection_name, "table_relations", payload)
                .await?
            {
                saved_kinds.push("table_relations".to_string());
            }
        }
        Err(e) => errors.push(format!("table_relations: {}", e.user_message())),
    }

    Ok(ResourceSnapshotResult { saved_kinds, errors })
}

/// 保存观测记录的内部辅助：返回 true 表示保存成功。
async fn save_observation(
    state: &AppState,
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
    match storage.save_resource_observation(&obs) {
        Ok(()) => Ok(true),
        Err(e) => Err(OmniError::from(e)),
    }
}

// ── SSH 采集子任务 ───────────────────────────────────────────────────

async fn collect_ssh_hardware(session: &Arc<SshSession>) -> OmniResult<Value> {
    let os_info = session.exec_capture("uname -a").await?;
    let nproc = session.exec_capture("nproc").await?;
    let meminfo = session.exec_capture("free -b").await?;
    let disk = session.exec_capture("df -B1").await?;

    let cpu_cores: u32 = nproc
        .stdout
        .trim()
        .parse::<u32>()
        .unwrap_or(0);

    Ok(json!({
        "os": os_info.stdout.trim(),
        "cpu_cores": cpu_cores,
        "memory_raw": meminfo.stdout,
        "disk_raw": disk.stdout,
    }))
}

async fn collect_ssh_services(session: &Arc<SshSession>) -> OmniResult<Value> {
    // systemd 系统的运行中服务（取前 50 条避免 payload 过大）
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
        .exec_capture(
            "ss -tlnp 2>/dev/null | head -30 || netstat -tlnp 2>/dev/null | head -30",
        )
        .await?;

    Ok(json!({
        "interfaces": ip_addr.stdout,
        "listening_ports": listening.stdout,
    }))
}

// ── DB 采集子任务 ────────────────────────────────────────────────────

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
        "postgres" | "postgresql" | "pg" => {
            "SELECT current_database() AS table_schema, \
                    COUNT(*) AS table_count, \
                    ROUND(pg_database_size(current_database()) / 1024 / 1024, 2) AS size_mb \
             FROM information_schema.tables WHERE table_schema = 'public'"
                .to_string()
        }
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

/// Phase 5 子任务 1：表关系推断采集器。
///
/// 从 performance_schema.events_statements_summary_by_digest（MySQL/MariaDB）
/// 或 pg_stat_statements（PostgreSQL）拉取最近高频 SQL 文本，用轻量正则识别
/// `FROM`、`JOIN`、`UPDATE`、`INTO` 后的表名，构造表关系对列表。
///
/// 返回 payload 结构：
/// ```json
/// {
///   "source": "performance_schema" | "pg_stat_statements",
///   "pairs": [["t1","t2"], ...],
///   "join_types": ["INNER", "LEFT", ...],
///   "table_hit_counts": { "t1": 5, "t2": 3 },
///   "sql_sample_count": 42
/// }
/// ```
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
    let mut table_hit_counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    let mut sql_sample_count: u32 = 0;

    for row in &res.rows {
        // 第一列是 SQL 文本（DIGEST_TEXT 或 query）
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
        // 提取 join 类型并构造表对
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
        // 对于多表 FROM（子查询或逗号分隔），构造笛卡尔对
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

    // 限制返回大小，避免 payload 过大
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

/// 从 SQL 文本中提取表名（FROM / JOIN / UPDATE / INTO 后的标识符）。
/// 轻量实现：不依赖完整 SQL parser，用正则识别常见模式。
fn extract_table_names(sql: &str) -> Vec<String> {
    let mut tables: Vec<String> = Vec::new();
    // 大小写不敏感匹配，支持反引号、双引号、方括号包裹的表名。
    // 使用 r#"..."# 原始字符串避免转义双引号；字符类内反引号/双引号无需转义。
    let patterns: &[&str] = &[
        // FROM <table> 或 FROM <table1>, <table2>
        r#"(?i)\bFROM\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
        // JOIN <table>
        r#"(?i)\bJOIN\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
        // UPDATE <table>
        r#"(?i)\bUPDATE\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
        // INTO <table>
        r#"(?i)\bINTO\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?"#,
    ];
    for pat in patterns {
        if let Ok(re) = regex::Regex::new(pat) {
            for cap in re.captures_iter(sql) {
                if let Some(m) = cap.get(1) {
                    let name = m.as_str().trim_matches(|c| c == '`' || c == '"' || c == ']');
                    // 过滤掉 SQL 关键字误匹配（如子查询里的 SELECT/JOIN 等）
                    let upper = name.to_uppercase();
                    if !matches!(
                        upper.as_str(),
                        "SELECT" | "WHERE" | "GROUP" | "ORDER" | "LIMIT" | "SET" | "VALUES"
                            | "ON" | "AS" | "JOIN" | "LEFT" | "RIGHT" | "INNER" | "OUTER"
                            | "FROM" | "UPDATE" | "INTO" | "DUAL"
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

/// 从 SQL 文本中提取 JOIN 子句（左表、右表、join 类型）。
struct JoinClause {
    join_type: String,
    left_table: String,
    right_table: String,
}

fn extract_join_clauses(sql: &str) -> Vec<JoinClause> {
    let mut result: Vec<JoinClause> = Vec::new();
    // 匹配 [LEFT|RIGHT|INNER|OUTER|CROSS] JOIN <right_table> ON <left_table>.col = <right_table>.col
    let re = regex::Regex::new(
        r#"(?i)\b((?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN)\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?[^;]*?\bON\b\s+[`"\[]?([a-zA-Z_][a-zA-Z0-9_\.]*)[`"\]]?\."#,
    );
    if let Ok(re) = re {
        for cap in re.captures_iter(sql) {
            let join_kw = cap.get(1).map(|m| m.as_str().trim().to_uppercase()).unwrap_or_default();
            let right_table = cap
                .get(2)
                .map(|m| m.as_str().trim_matches(|c| c == '`' || c == '"' || c == ']').to_string())
                .unwrap_or_default();
            let left_table = cap
                .get(3)
                .map(|m| m.as_str().trim_matches(|c| c == '`' || c == '"' || c == ']').to_string())
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

#[cfg(test)]
mod tests {
    #[test]
    fn obs_id_has_resource_type_prefix() {
        // 仅验证 obs_id 格式正确（不验证唯一性，因为 nanos 在快速连续调用下可能相同）
        let id = super::obs_id("ssh");
        assert!(id.starts_with("obs_ssh_"), "id 应以 obs_ssh_ 开头: {id}");
    }
}
