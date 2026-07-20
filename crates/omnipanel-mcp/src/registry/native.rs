use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_store::{
    list_all_skill_records, load_database_connections, load_skill_body, load_skill_record,
    parse_skill_md, skill_file_path, write_skill, ConnectionKind, HttpProxyConfig, KnowledgeEntry,
    ResourceObservation, SkillApplication, SkillDbRecord, SkillFrontmatter, Storage,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

/// 本地 Docker Engine 的固定 connection_id（与 src-tauri 的 LOCAL_CONNECTION_ID 保持一致）。
const DOCKER_LOCAL_CONNECTION_ID: &str = "docker-local";

/// 本机文件系统的固定 connection_id（与 src-tauri 的 file_manager::LOCAL_CONNECTION_ID 一致）。
const FILES_LOCAL_CONNECTION_ID: &str = "__local__";

/// rmcp 宏注册的工具（与 `builtin.rs` tool_router 保持一致）。
const ROUTER_NATIVE_TOOLS: &[&str] = &[
    "omni_knowledge_create_document",
    "omni_knowledge_remove_document",
    "omni_knowledge_list_documents",
];

pub fn is_router_native_tool(name: &str) -> bool {
    ROUTER_NATIVE_TOOLS.contains(&name)
}

/// 工具参数 schema —— 统一取自 omnipanel-store 的单一真相源 `BUILTIN_TOOL_SPECS`。
/// 未知工具回退为空 object。
pub fn input_schema_for(tool_name: &str) -> Value {
    omnipanel_store::builtin_tool_spec(tool_name)
        .and_then(|spec| serde_json::from_str(spec.input_schema).ok())
        .unwrap_or_else(|| {
            serde_json::json!({
                "type": "object",
                "properties": {}
            })
        })
}

pub async fn execute(
    name: &str,
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
    proxy: Option<HttpProxyConfig>,
) -> Result<(String, bool), String> {
    match name {
        "omni_knowledge_create_document" => create_document(arguments, storage).await,
        "omni_knowledge_remove_document" => remove_document(arguments, storage).await,
        "omni_knowledge_list_documents" => list_documents(arguments, storage).await,
        "omni_database_list_connections" => list_database_connections(arguments).await,
        "omni_ssh_list_connections" => list_ssh_connections(arguments, storage).await,
        "omni_docker_list_connections" => list_docker_connections(arguments, storage).await,
        "omni_files_list_connections" => list_file_connections(arguments, storage).await,
        "load_skill" => load_skill(arguments).await,
        "omni_resource_get_profile" => resource_get_profile(arguments, storage).await,
        "omni_resource_find_similar" => resource_find_similar(arguments, storage).await,
        "omni_resource_update_profile" => resource_update_profile(arguments, storage).await,
        "omni_skill_recall" => skill_recall(arguments, storage).await,
        "omni_skill_extract_experience" => skill_extract_experience(arguments, storage).await,
        "omni_skill_refine" => skill_refine(arguments, storage).await,
        "omni_web_search" => super::web::search::dispatch(arguments, storage, proxy).await,
        "omni_zhihu_search" => {
            super::web::search::dispatch_zhihu_only(arguments, storage, proxy).await
        }
        "omni_web_fetch" => super::web::fetch::dispatch(arguments, storage, proxy).await,
        _ => Err(format!("未知 Native 工具: {name}")),
    }
}

fn keyword_filter(keyword: Option<&str>, name: &str) -> bool {
    let Some(kw) = keyword.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    name.to_ascii_lowercase().contains(&kw.to_ascii_lowercase())
}

#[derive(Serialize)]
struct DbConnectionSummary {
    id: String,
    name: String,
    db_type: String,
    host: String,
    port: u16,
    user: String,
    database: String,
    enabled: bool,
}

async fn list_database_connections(arguments: Value) -> Result<(String, bool), String> {
    let keyword = arguments.get("keyword").and_then(|v| v.as_str());
    let connections = load_database_connections().map_err(|e| e.to_string())?;
    let summaries: Vec<DbConnectionSummary> = connections
        .into_iter()
        .filter(|c| keyword_filter(keyword, &c.name))
        .map(|c| DbConnectionSummary {
            id: c.id,
            name: c.name,
            db_type: c.db_type,
            host: c.host,
            port: c.port,
            user: c.user,
            database: c.database,
            enabled: c.enabled,
        })
        .collect();
    Ok((
        serde_json::to_string(&summaries).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}

#[derive(Serialize)]
struct SshConnectionSummary {
    id: String,
    name: String,
    env_tag: String,
    group: String,
    tags: Vec<String>,
}

async fn list_ssh_connections(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let keyword = arguments.get("keyword").and_then(|v| v.as_str());
    let storage = storage.lock().await;
    let connections = storage
        .list_connections_by_kind(ConnectionKind::Ssh)
        .map_err(|e| e.to_string())?;
    let summaries: Vec<SshConnectionSummary> = connections
        .into_iter()
        .filter(|c| keyword_filter(keyword, &c.name))
        .map(|c| SshConnectionSummary {
            id: c.id,
            name: c.name,
            env_tag: c.env_tag,
            group: c.group,
            tags: c.tags,
        })
        .collect();
    Ok((
        serde_json::to_string(&summaries).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}

#[derive(Serialize)]
struct DockerConnectionSummary {
    connection_id: String,
    name: String,
    /// 来源：local-engine / remote-engine / ssh-engine / onepanel / panel-adapter
    source: String,
    /// 主机标签（host / user@host / base_url / "本地 Engine"）
    host_label: String,
    environment: String,
    /// 绑定的 SSH 连接 id（若 SSH Engine 复用 ssh_pool）
    bound_ssh_connection_id: Option<String>,
}

/// 列出已保存的 Docker 连接 + 本地 Engine 伪连接。
///
/// 与 src-tauri 的 `docker_list_connections` 区别：
/// - 不检查本地 Docker Engine 是否实际安装/运行（外部 MCP 路径不便做系统调用），
///   始终把 `docker-local` 列在结果里，调用方在实际连接时才会发现是否可用。
/// - 不读取每条连接的运行时状态（在线/离线），统一返回 `status: "unknown"`。
async fn list_docker_connections(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let keyword = arguments.get("keyword").and_then(|v| v.as_str());
    let storage = storage.lock().await;
    let connections = storage
        .list_connections_by_kind(ConnectionKind::Docker)
        .map_err(|e| e.to_string())?;

    let mut summaries: Vec<DockerConnectionSummary> = Vec::new();
    // 本地 Engine 伪连接始终列在首位
    summaries.push(DockerConnectionSummary {
        connection_id: DOCKER_LOCAL_CONNECTION_ID.to_string(),
        name: "本地 Docker".to_string(),
        source: "local-engine".to_string(),
        host_label: "本地 Engine".to_string(),
        environment: "local".to_string(),
        bound_ssh_connection_id: None,
    });

    for c in connections {
        if !keyword_filter(keyword, &c.name) {
            continue;
        }
        // 解析 config 提取 source / host_label / bound_ssh
        let cfg: serde_json::Value = serde_json::from_str(&c.config).unwrap_or_default();
        let source = cfg
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("local-engine")
            .to_string();
        let host_label = cfg
            .get("host")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                cfg.get("ssh")
                    .and_then(|s| {
                        let user = s.get("user").and_then(|v| v.as_str()).unwrap_or("");
                        let host = s.get("host").and_then(|v| v.as_str()).unwrap_or("");
                        if !user.is_empty() || !host.is_empty() {
                            Some(format!("{user}@{host}"))
                        } else {
                            None
                        }
                    })
            })
            .or_else(|| {
                cfg.get("onepanel")
                    .and_then(|p| p.get("baseUrl"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| c.name.clone());
        let bound_ssh = cfg
            .get("boundSshConnectionId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string);
        summaries.push(DockerConnectionSummary {
            connection_id: c.id,
            name: c.name,
            source,
            host_label,
            environment: c.env_tag,
            bound_ssh_connection_id: bound_ssh,
        });
    }

    Ok((
        serde_json::to_string(&summaries).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}

async fn load_skill(arguments: Value) -> Result<(String, bool), String> {
    let name = arguments
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "name 不能为空".to_string())?;
    omnipanel_store::load_skill_body(name).map(|body| (body, true))
}

// ── 资源档案（resource_profile）工具 ───────────────────────────────

/// 校验 resource_type 必须为合法枚举值；返回 trim 后的 owned String。
fn require_resource_type(arguments: &Value) -> Result<String, String> {
    let rt = arguments
        .get("resource_type")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "resource_type 不能为空".to_string())?;
    if !matches!(rt, "ssh" | "database" | "docker" | "files") {
        return Err(format!(
            "resource_type 非法：{rt}（应为 ssh / database / docker / files）"
        ));
    }
    Ok(rt.to_string())
}

fn require_resource_id(arguments: &Value) -> Result<String, String> {
    arguments
        .get("resource_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "resource_id 不能为空".to_string())
}

/// 获取资源档案：每类 observation_kind 最新一条，组装为 JSON 对象。
/// 返回：`{ resource_type, resource_id, latest_observed_at, observations: { kind: { payload, observed_at, observer } } }`
async fn resource_get_profile(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let resource_type = require_resource_type(&arguments)?;
    let resource_id = require_resource_id(&arguments)?;
    let storage = storage.lock().await;
    let profile = storage
        .get_latest_resource_profile(&resource_type, &resource_id)
        .map_err(|e| e.to_string())?;
    match profile {
        Some(v) => Ok((v.to_string(), true)),
        None => Ok((
            serde_json::json!({
                "resource_type": resource_type,
                "resource_id": resource_id,
                "latest_observed_at": 0,
                "observations": {},
                "found": false,
            })
            .to_string(),
            true,
        )),
    }
}

/// 查找相似资源（同 resource_type、按指纹相似度排序）。
async fn resource_find_similar(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let resource_type = require_resource_type(&arguments)?;
    let resource_id = require_resource_id(&arguments)?;
    let limit = arguments
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(5)
        .clamp(1, 20) as usize;
    let storage = storage.lock().await;
    let similar = storage
        .find_similar_resources(&resource_type, &resource_id, limit)
        .map_err(|e| e.to_string())?;
    Ok((
        serde_json::to_string(&similar).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}

/// 追加一条资源观测记录（append-only，不覆盖历史）。
async fn resource_update_profile(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let resource_type = require_resource_type(&arguments)?;
    let resource_id = require_resource_id(&arguments)?;
    let observation_kind = arguments
        .get("observation_kind")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "observation_kind 不能为空".to_string())?
        .to_string();
    let payload = arguments
        .get("payload")
        .cloned()
        .filter(|v| v.is_object())
        .ok_or_else(|| "payload 必须是 JSON 对象".to_string())?;
    let observer = arguments
        .get("observer")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("ai")
        .to_string();
    if !matches!(observer.as_str(), "auto" | "manual" | "ai") {
        return Err(format!(
            "observer 非法：{observer}（应为 auto / manual / ai）"
        ));
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = format!("obs_{resource_type}_{now}");

    let obs = ResourceObservation {
        id: id.clone(),
        resource_type: resource_type.clone(),
        resource_id: resource_id.clone(),
        observation_kind: observation_kind.clone(),
        payload,
        observed_at: now as i64,
        observer,
    };

    let storage = storage.lock().await;
    storage
        .save_resource_observation(&obs)
        .map_err(|e| e.to_string())?;
    Ok((
        serde_json::json!({
            "id": id,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "observation_kind": observation_kind,
            "observed_at": now as i64,
            "saved": true,
        })
        .to_string(),
        true,
    ))
}

// ── Skill 自我进化工具 ─────────────────────────────────────────────

/// Slug 化字符串：小写 + 空格/下划线转连字符 + 只保留 alphanumeric 和连字符。
fn slugify(input: &str) -> String {
    let trimmed = input.trim().to_ascii_lowercase();
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if ch == ' ' || ch == '_' {
            out.push('-');
        } else if ch == '-' {
            out.push('-');
        }
        // 其他字符跳过
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').to_string()
}

/// 生成新 skill id：slug + 可选版本后缀。
fn generate_skill_id(slug: &str, version_suffix: Option<i64>) -> String {
    let base = if slug.is_empty() {
        "skill".to_string()
    } else {
        slug.to_string()
    };
    match version_suffix {
        Some(v) if v > 1 => format!("{base}-v{v}"),
        _ => base,
    }
}

/// 同步文件层 skill 到 DB：对没有 DB 记录的 skill 创建 v1 记录。
/// 用于在 v24 迁移后首次访问老 skill 时补齐 DB 元数据。
fn ensure_skill_db_sync(storage: &Storage) -> Result<(), String> {
    let file_records = list_all_skill_records().map_err(|e| e.to_string())?;
    for fr in file_records {
        if storage
            .get_skill_db(&fr.id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            let db_rec = SkillDbRecord {
                id: fr.id.clone(),
                name: fr.name.clone(),
                description: fr.description.clone(),
                enabled: fr.enabled,
                version: 1,
                parent_version_id: String::new(),
                path: fr.path.clone(),
                success_count: 0,
                failure_count: 0,
                last_applied_at: None,
                shareable: false,
                created_at: fr.created_at,
                updated_at: fr.updated_at,
            };
            storage.save_skill_db(&db_rec).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 禁用 skill（文件层 frontmatter enabled=false）。
fn disable_skill_file(skill_id: &str) -> Result<(), String> {
    let file = skill_file_path(skill_id)?;
    let raw = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut parsed = parse_skill_md(&raw)?;
    parsed.frontmatter.enabled = false;
    write_skill(skill_id, parsed.frontmatter, &parsed.body)?;
    Ok(())
}

/// 当前毫秒时间戳。
fn now_millis_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 召回相关 skill：基于自然语言查询匹配已启用的 skill。
/// 当前实现：关键词匹配（向量检索待 Phase 5+）。
async fn skill_recall(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let query = arguments
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "query 不能为空".to_string())?
        .to_string();
    let resource_type = arguments
        .get("resource_type")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(rt) = &resource_type {
        if !matches!(rt.as_str(), "ssh" | "database" | "docker" | "files") {
            return Err(format!(
                "resource_type 非法：{rt}（应为 ssh / database / docker / files）"
            ));
        }
    }
    let top_k = arguments
        .get("top_k")
        .and_then(|v| v.as_i64())
        .unwrap_or(3)
        .clamp(1, 10) as usize;

    // 1. 获取所有已启用 skill 摘要（文件层）
    let summaries =
        omnipanel_store::list_enabled_skill_summaries().map_err(|e| e.to_string())?;

    // 2. 加载每个 skill 的正文并计算匹配分数
    let query_lower = query.to_ascii_lowercase();
    let query_terms: Vec<&str> = query_lower
        .split_whitespace()
        .filter(|s| s.len() >= 2)
        .collect();

    #[allow(clippy::type_complexity)]
    let mut scored: Vec<(String, String, String, String, i64)> = Vec::new();
    for (id, name, desc) in summaries {
        let body = match load_skill_body(&id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // 如果指定 resource_type，检查 skill 文本是否提及该类型相关关键词
        if let Some(rt) = &resource_type {
            let rt_keywords: Vec<&str> = match rt.as_str() {
                "ssh" => vec!["ssh", "shell", "linux", "server", "host", "remote"],
                "database" => vec!["database", "mysql", "postgres", "sql", "table", "db"],
                "docker" => vec!["docker", "container", "image", "compose", "podman"],
                "files" => vec!["file", "sftp", "directory", "path", "folder"],
                _ => vec![],
            };
            let text = format!("{} {} {}", name, desc, body).to_ascii_lowercase();
            if !rt_keywords.iter().any(|k| text.contains(k)) {
                continue;
            }
        }
        let text = format!("{} {} {}", name, desc, body).to_ascii_lowercase();
        let mut score: i64 = 0;
        for term in &query_terms {
            if text.contains(term) {
                score += 1;
            }
        }
        // 完整 query 子串匹配加分
        if text.contains(&query_lower) {
            score += 3;
        }
        // name 完全匹配 query 加大分
        if name.to_ascii_lowercase() == query_lower {
            score += 5;
        }
        if score > 0 {
            scored.push((id, name, desc, body, score));
        }
    }

    // 3. 按分数倒序，取 top_k
    scored.sort_by(|a, b| b.4.cmp(&a.4));
    let results: Vec<_> = scored.into_iter().take(top_k).collect();

    // 4. 为每个命中的 skill 记录一条 pending 应用记录（便于后续追踪）
    let storage = storage.lock().await;
    ensure_skill_db_sync(&storage)?;
    let now = now_millis_i64();
    let session_id = arguments
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut json_results = Vec::new();
    for (id, name, desc, body, score) in &results {
        let app_id = format!("app_{id}_{now}");
        let app = SkillApplication {
            id: app_id.clone(),
            skill_id: id.clone(),
            session_id: session_id.clone(),
            resource_type: resource_type.clone().unwrap_or_default(),
            resource_id: String::new(),
            outcome: "pending".to_string(),
            feedback: format!("query: {query}"),
            applied_at: now,
        };
        let _ = storage.save_skill_application(&app);
        json_results.push(serde_json::json!({
            "id": id,
            "name": name,
            "description": desc,
            "body": body,
            "score": score,
            "application_id": app_id,
        }));
    }

    Ok((
        serde_json::json!({
            "query": query,
            "resource_type": resource_type,
            "results": json_results,
            "count": json_results.len(),
        })
        .to_string(),
        true,
    ))
}

/// 从完成的任务中提取经验并创建 skill。
/// 支持创建初版 skill（无 parent）或基于已有 skill 创建新版本（传入 parent_skill_id）。
async fn skill_extract_experience(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let title = arguments
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "title 不能为空".to_string())?
        .to_string();
    let description = arguments
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "description 不能为空".to_string())?
        .to_string();
    let body = arguments
        .get("body")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "body 不能为空".to_string())?
        .to_string();
    let resource_type = arguments
        .get("resource_type")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let resource_id = arguments
        .get("resource_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let knowledge_ids: Vec<String> = arguments
        .get("knowledge_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let parent_skill_id = arguments
        .get("parent_skill_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let slug = slugify(&title);
    let now = now_millis_i64();

    // 处理父版本
    let (new_id, new_version, parent_version_id) = if let Some(parent_id) = &parent_skill_id {
        let storage = storage.lock().await;
        ensure_skill_db_sync(&storage)?;
        let parent = storage
            .get_skill_db(parent_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("父 skill 不存在: {parent_id}"))?;
        let new_version = parent.version + 1;
        let new_id = generate_skill_id(&slug, Some(new_version));
        // 禁用父版本（文件 + DB）
        disable_skill_file(&parent.id)?;
        let mut disabled = parent.clone();
        disabled.enabled = false;
        disabled.updated_at = now;
        storage.save_skill_db(&disabled).map_err(|e| e.to_string())?;
        (new_id, new_version, parent.id.clone())
    } else {
        let candidate = generate_skill_id(&slug, None);
        // 如果 id 已存在，加时间戳后缀避免冲突
        let new_id = if load_skill_record(&candidate).is_ok() {
            format!("{candidate}-{now}")
        } else {
            candidate
        };
        (new_id, 1, String::new())
    };

    // 写入 SKILL.md（文件层）
    let record = write_skill(
        &new_id,
        SkillFrontmatter {
            name: title.clone(),
            description: description.clone(),
            enabled: true,
        },
        &body,
    )
    .map_err(|e| e.to_string())?;

    // 保存 DB 记录 + 关联 knowledge
    let case_knowledge_id = {
        let storage = storage.lock().await;
        let db_rec = SkillDbRecord {
            id: new_id.clone(),
            name: title.clone(),
            description: description.clone(),
            enabled: true,
            version: new_version,
            parent_version_id: parent_version_id.clone(),
            path: record.path.clone(),
            success_count: 0,
            failure_count: 0,
            last_applied_at: None,
            shareable: false,
            created_at: record.created_at,
            updated_at: record.updated_at,
        };
        storage.save_skill_db(&db_rec).map_err(|e| e.to_string())?;

        // 关联 knowledge 条目
        for kid in &knowledge_ids {
            let _ = storage.link_skill_knowledge(&new_id, kid, "source");
        }

        // 如果指定了 resource_type + resource_id，创建一条 case 知识库条目
        if let (Some(rt), Some(rid)) = (&resource_type, &resource_id) {
            let case_id = format!("case_{new_id}_{now}");
            let entry = KnowledgeEntry {
                id: case_id.clone(),
                kind: "case".to_string(),
                title: format!("Case: {title}"),
                content: format!(
                    "## 关联 Skill\n\n{new_id}\n\n## 关联资源\n\n{rt}: {rid}\n\n## 描述\n\n{description}\n\n## 正文\n\n{body}"
                ),
                tags: vec![rt.clone(), "skill-case".to_string()],
                risk_level: "safe".to_string(),
                source: "skill-extract".to_string(),
                env_tag: "dev".to_string(),
                language: String::new(),
                usage_count: 0,
                created_at: now,
                updated_at: now,
                parent_id: String::new(),
                node_type: "document".to_string(),
                sort_order: 0,
                resource_type: rt.clone(),
                resource_id: rid.clone(),
            };
            let _ = storage.save_knowledge(&entry);
            let _ = storage.link_skill_knowledge(&new_id, &case_id, "case");
            Some(case_id)
        } else {
            None
        }
    };

    Ok((
        serde_json::json!({
            "id": new_id,
            "version": new_version,
            "parent_version_id": parent_version_id,
            "name": title,
            "description": description,
            "knowledge_ids_linked": knowledge_ids.len(),
            "case_knowledge_id": case_knowledge_id,
            "created": true,
        })
        .to_string(),
        true,
    ))
}

/// 改进已有 skill：基于反馈创建新版本，原版本 enabled=0。
async fn skill_refine(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let skill_id = arguments
        .get("skill_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "skill_id 不能为空".to_string())?
        .to_string();
    let improvements = arguments
        .get("improvements")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "improvements 不能为空".to_string())?
        .to_string();
    let new_body = arguments
        .get("new_body")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "new_body 不能为空".to_string())?
        .to_string();
    let new_description = arguments
        .get("new_description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // 加载父版本（文件层）
    let parent_record =
        load_skill_record(&skill_id).map_err(|e| e.to_string())?;

    let storage = storage.lock().await;
    ensure_skill_db_sync(&storage)?;
    let parent_db = storage
        .get_skill_db(&skill_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("skill DB 记录不存在: {skill_id}"))?;

    let new_version = parent_db.version + 1;
    let slug = slugify(&parent_record.name);
    let candidate_id = generate_skill_id(&slug, Some(new_version));
    let now = now_millis_i64();
    // 如果 id 冲突，加时间戳后缀
    let new_id = if load_skill_record(&candidate_id).is_ok() {
        format!("{candidate_id}-{now}")
    } else {
        candidate_id
    };

    // 禁用父版本（文件 + DB）
    disable_skill_file(&skill_id)?;
    let mut disabled_parent = parent_db.clone();
    disabled_parent.enabled = false;
    disabled_parent.updated_at = now;
    storage.save_skill_db(&disabled_parent).map_err(|e| e.to_string())?;

    // 写入新版本 SKILL.md（在 body 末尾追加改进说明作为 HTML 注释）
    let final_body = format!("{new_body}\n\n<!-- improvements: {improvements} -->\n");
    let final_description = new_description.unwrap_or_else(|| parent_record.description.clone());
    let new_record = write_skill(
        &new_id,
        SkillFrontmatter {
            name: parent_record.name.clone(),
            description: final_description.clone(),
            enabled: true,
        },
        &final_body,
    )
    .map_err(|e| e.to_string())?;

    // 保存新版本 DB 记录
    let new_db_rec = SkillDbRecord {
        id: new_id.clone(),
        name: parent_record.name.clone(),
        description: final_description.clone(),
        enabled: true,
        version: new_version,
        parent_version_id: skill_id.clone(),
        path: new_record.path.clone(),
        success_count: 0,
        failure_count: 0,
        last_applied_at: None,
        shareable: parent_db.shareable,
        created_at: new_record.created_at,
        updated_at: new_record.updated_at,
    };
    storage.save_skill_db(&new_db_rec).map_err(|e| e.to_string())?;

    // 复制父版本的 knowledge 关联到新版本
    let parent_links = storage
        .list_knowledge_for_skill(&skill_id)
        .map_err(|e| e.to_string())?;
    for link in parent_links {
        let _ = storage.link_skill_knowledge(&new_id, &link.knowledge_id, &link.link_kind);
    }

    // 记录一条 refined 应用记录
    let app_id = format!("app_{new_id}_{now}");
    let app = SkillApplication {
        id: app_id.clone(),
        skill_id: new_id.clone(),
        session_id: String::new(),
        resource_type: String::new(),
        resource_id: String::new(),
        outcome: "refined".to_string(),
        feedback: improvements.clone(),
        applied_at: now,
    };
    let _ = storage.save_skill_application(&app);

    // 获取版本链
    let chain = storage
        .get_skill_version_chain(&new_id)
        .map_err(|e| e.to_string())?;
    let chain_json: Vec<_> = chain
        .into_iter()
        .map(|(id, version, created_at)| {
            serde_json::json!({
                "id": id,
                "version": version,
                "created_at": created_at,
            })
        })
        .collect();

    Ok((
        serde_json::json!({
            "id": new_id,
            "version": new_version,
            "parent_version_id": skill_id,
            "name": parent_record.name,
            "description": final_description,
            "improvements": improvements,
            "application_id": app_id,
            "version_chain": chain_json,
            "created": true,
        })
        .to_string(),
        true,
    ))
}

async fn create_document(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let title = arguments
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let content = arguments
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if title.trim().is_empty() {
        return Err("title 不能为空".to_string());
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let id = format!("doc_{now}");
    let entry = KnowledgeEntry {
        id: id.clone(),
        kind: arguments
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("snippet")
            .to_string(),
        title,
        content,
        tags: arguments
            .get("tags")
            .and_then(|v| v.as_str())
            .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default(),
        risk_level: arguments
            .get("risk_level")
            .and_then(|v| v.as_str())
            .unwrap_or("safe")
            .to_string(),
        source: arguments
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("ai")
            .to_string(),
        env_tag: arguments
            .get("env_tag")
            .and_then(|v| v.as_str())
            .unwrap_or("dev")
            .to_string(),
        language: String::new(),
        usage_count: 0,
        created_at: now as i64,
        updated_at: now as i64,
        parent_id: arguments
            .get("parent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        node_type: "document".to_string(),
        sort_order: 0,
        resource_type: arguments
            .get("resource_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        resource_id: arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };

    let storage = storage.lock().await;
    storage
        .save_knowledge(&entry)
        .map_err(|e| e.to_string())?;
    Ok((serde_json::json!({ "id": id }).to_string(), true))
}

async fn remove_document(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let id = arguments
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "id 不能为空".to_string())?;
    let storage = storage.lock().await;
    storage.delete_knowledge(id).map_err(|e| e.to_string())?;
    Ok((serde_json::json!({ "deleted": true, "id": id }).to_string(), true))
}

async fn list_documents(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let kind = arguments.get("kind").and_then(|v| v.as_str());
    let tag = arguments.get("tag").and_then(|v| v.as_str());
    let storage = storage.lock().await;
    let entries = storage
        .list_knowledge(kind, tag)
        .map_err(|e| e.to_string())?;
    Ok((
        serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}

#[derive(Serialize)]
struct FileConnectionSummary {
    connection_id: String,
    name: String,
    /// 协议：local / sftp / ftp / s3
    protocol: String,
    /// 主机标签（host / user@host / bucket@region / "本机文件系统"）
    host_label: String,
    environment: String,
    group: String,
    /// 绑定的 SSH 连接 id（若 SFTP 复用 ssh_pool）
    bound_ssh_connection_id: Option<String>,
}

/// 列出已保存的文件管理器连接 + 本机伪连接。
///
/// 与 src-tauri 的 `file_list_connections` 区别：
/// - 不检查实际连接 online 状态（外部 MCP 路径不便访问 AppState.file_sftp_sessions），
///   统一不返回 status 字段（调用方按需自检）。
/// - 始终把 `__local__` 列在结果首位。
async fn list_file_connections(
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, bool), String> {
    let keyword = arguments.get("keyword").and_then(|v| v.as_str());
    let storage = storage.lock().await;
    let connections = storage
        .list_connections_by_kind(ConnectionKind::File)
        .map_err(|e| e.to_string())?;

    let mut summaries: Vec<FileConnectionSummary> = Vec::new();
    // 本机伪连接始终列在首位
    summaries.push(FileConnectionSummary {
        connection_id: FILES_LOCAL_CONNECTION_ID.to_string(),
        name: "本机文件系统".to_string(),
        protocol: "local".to_string(),
        host_label: "本机".to_string(),
        environment: "local".to_string(),
        group: "本地文件".to_string(),
        bound_ssh_connection_id: None,
    });

    for c in connections {
        if !keyword_filter(keyword, &c.name) {
            continue;
        }
        // 解析 config 提取 protocol / host_label / bound_ssh
        let cfg: serde_json::Value = serde_json::from_str(&c.config).unwrap_or_default();
        let protocol = cfg
            .get("protocol")
            .and_then(|v| v.as_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_else(|| {
                // 协议未显式声明时按字段推断
                if cfg.get("bucket").and_then(|v| v.as_str()).is_some() {
                    "s3".to_string()
                } else if cfg.get("host").and_then(|v| v.as_str()).is_some() {
                    "sftp".to_string()
                } else {
                    "local".to_string()
                }
            });
        let host_label = match protocol.as_str() {
            "s3" => {
                let bucket = cfg.get("bucket").and_then(|v| v.as_str()).unwrap_or("");
                let region = cfg.get("region").and_then(|v| v.as_str()).unwrap_or("");
                if !region.is_empty() {
                    format!("{bucket}@{region}")
                } else {
                    bucket.to_string()
                }
            }
            "ftp" | "sftp" => {
                let user = cfg.get("user").and_then(|v| v.as_str()).unwrap_or("");
                let host = cfg.get("host").and_then(|v| v.as_str()).unwrap_or("");
                if !user.is_empty() {
                    format!("{user}@{host}")
                } else {
                    host.to_string()
                }
            }
            _ => c.name.clone(),
        };
        let bound_ssh = cfg
            .get("sshConnectionId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string);
        summaries.push(FileConnectionSummary {
            connection_id: c.id,
            name: c.name,
            protocol,
            host_label,
            environment: c.env_tag,
            group: c.group,
            bound_ssh_connection_id: bound_ssh,
        });
    }

    Ok((
        serde_json::to_string(&summaries).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}
