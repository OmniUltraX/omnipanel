use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_store::{
    load_database_connections, ConnectionKind, HttpProxyConfig, KnowledgeEntry, Storage,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

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
        "load_skill" => load_skill(arguments).await,
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

async fn load_skill(arguments: Value) -> Result<(String, bool), String> {
    let name = arguments
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "name 不能为空".to_string())?;

    let root = omnipanel_store::skills_root().map_err(|e| e.to_string())?;
    if !root.exists() {
        return Err(format!("未找到 Skill: {name}"));
    }

    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let skill_file = entry.path().join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&skill_file).map_err(|e| e.to_string())?;
        if id == name {
            return Ok((extract_skill_body(&raw), true));
        }
        if let Some(fm_name) = parse_skill_frontmatter_name(&raw) {
            if fm_name == name {
                return Ok((extract_skill_body(&raw), true));
            }
        }
    }
    Err(format!("未找到 Skill: {name}"))
}

fn parse_skill_frontmatter_name(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let front = &rest[..end];
    for line in front.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("name:") {
            return Some(v.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn extract_skill_body(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..];
            return after.trim_start_matches(['\r', '\n']).to_string();
        }
    }
    raw.to_string()
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
