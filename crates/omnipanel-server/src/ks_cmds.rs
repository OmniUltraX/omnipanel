//! Web 知识源：`ks_test` / `ks_sync_now` / `ks_sync_rebuild` 走同一套 L2 执行器。

use omnipanel_error::OmniError;
use omnipanel_knowledge_source::{
    KsReport, MethodCaller, PluginAdapter, SourceAdapter,
};
use omnipanel_store::Storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::terminal::ServerState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KsTestResult {
    pub ok: bool,
    pub notebooks: i64,
    pub docs: i64,
    pub message: String,
}

struct KsSourceField {
    key: String,
    kind: String,
}

struct ResolvedSource {
    namespace: String,
    list_method: String,
    list_documents_method: String,
    get_method: String,
    local_files: bool,
    siyuan_s3: bool,
    parse_method: String,
    file_patterns: Vec<String>,
    id_prefix: String,
    source_prefix: String,
    tag: String,
    fields: Vec<KsSourceField>,
}

struct GatewayCaller<'a> {
    state: &'a ServerState,
}

impl MethodCaller for GatewayCaller<'_> {
    fn call(&self, plugin_id: &str, method: &str, args: Value) -> Result<Value, String> {
        let plugin_id = plugin_id.to_string();
        let method = method.to_string();
        let state = self.state;
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                state
                    .plugins
                    .invoke(plugin_id, method, args)
                    .await
                    .map_err(|err| err.to_string())
            })
        })
    }
}

fn source_key_of(plugin_id: &str, source_id: &str) -> String {
    format!("plugin:{plugin_id}:{source_id}")
}

fn str_field(source: &Value, key: &str) -> String {
    source
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn opt_or_none(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn find_source(
    state: &ServerState,
    plugin_id: &str,
    source_id: &str,
) -> Result<ResolvedSource, OmniError> {
    let registry = state.plugins.registry.blocking_lock();
    let entry = registry
        .get(plugin_id)
        .ok_or_else(|| OmniError::not_found(format!("未知插件: {plugin_id}")))?;
    if !entry.enabled {
        return Err(OmniError::invalid_input(format!("插件未启用: {plugin_id}")));
    }
    let manifest = entry.manifest.clone();
    drop(registry);
    if manifest.kind != omnipanel_plugin::PluginKind::Knowledge {
        return Err(OmniError::invalid_input(format!(
            "插件不是 knowledge kind: {plugin_id}"
        )));
    }
    for source in &manifest.contributes.knowledge_sources {
        if str_field(source, "id") != source_id.trim() {
            continue;
        }
        let local_files = source
            .get("localFiles")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let siyuan_s3 = source
            .get("siyuanS3")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let namespace = str_field(source, "id");
        let tag = {
            let tag = str_field(source, "tag");
            if tag.is_empty() { namespace.clone() } else { tag }
        };
        let fields = source
            .get("fields")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|field| {
                        let key = field.get("key")?.as_str()?.trim().to_string();
                        if key.is_empty() {
                            return None;
                        }
                        Some(KsSourceField {
                            key,
                            kind: field
                                .get("kind")
                                .and_then(|v| v.as_str())
                                .unwrap_or("text")
                                .to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let resolved = ResolvedSource {
            namespace,
            list_method: str_field(source, "listMethod"),
            list_documents_method: str_field(source, "listDocumentsMethod"),
            get_method: str_field(source, "getMethod"),
            local_files,
            siyuan_s3,
            parse_method: str_field(source, "parseMethod"),
            file_patterns: source
                .get("filePatterns")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            id_prefix: {
                let prefix = str_field(source, "idPrefix");
                if prefix.is_empty() { "ks".into() } else { prefix }
            },
            source_prefix: {
                let prefix = str_field(source, "sourcePrefix");
                if prefix.is_empty() { "import:ks".into() } else { prefix }
            },
            tag,
            fields,
        };
        return Ok(resolved);
    }
    Err(OmniError::not_found(format!("插件未声明该知识源: {source_id}")))
}

fn extra_args_for(storage: &Storage, plugin_id: &str, source_id: &str, resolved: &ResolvedSource) -> Value {
    let mut out = serde_json::Map::new();
    let key = source_key_of(plugin_id, source_id);
    let (config_json, secret_map) = storage
        .ks_config_get(&key)
        .ok()
        .flatten()
        .map(|cfg| (cfg.config_json, cfg.secret_ref))
        .unwrap_or_default();
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&config_json) {
        for (k, v) in map {
            if v.is_string() || v.is_boolean() || v.is_number() {
                out.insert(k, v);
            }
        }
    }
    let secret_map: std::collections::HashMap<String, String> =
        serde_json::from_str(&secret_map).unwrap_or_default();
    for field in &resolved.fields {
        if field.kind != "secret" {
            continue;
        }
        let Some(vault_key) = secret_map.get(&field.key) else {
            continue;
        };
        if let Ok(secret) = omnipanel_store::Vault::get(vault_key) {
            if !secret.is_empty() {
                out.insert(field.key.clone(), Value::String(secret));
            }
        }
    }
    Value::Object(out)
}

async fn local_root_of(state: &ServerState, plugin_id: &str, source_id: &str) -> Result<std::path::PathBuf, OmniError> {
    let key = source_key_of(plugin_id, source_id);
    let root = {
        let storage = state.storage.lock().await;
        storage
            .ks_config_get(&key)?
            .and_then(|cfg| {
                serde_json::from_str::<Value>(&cfg.config_json)
                    .ok()?
                    .get("rootPath")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default()
    };
    if root.trim().is_empty() {
        return Err(OmniError::invalid_input("请先在源配置里填写本地根目录（rootPath）".to_string()));
    }
    let path = std::path::PathBuf::from(root.trim());
    if !path.is_dir() {
        return Err(OmniError::invalid_input(format!("本地根目录不存在或不可读: {}", path.display())));
    }
    Ok(path)
}

async fn s3_config_of(
    state: &ServerState,
    plugin_id: &str,
    source_id: &str,
) -> Result<omnipanel_knowledge_source::SiyuanS3Config, OmniError> {
    let key = source_key_of(plugin_id, source_id);
    let storage = state.storage.lock().await;
    let cfg = storage.ks_config_get(&key)?.ok_or_else(|| {
        OmniError::invalid_input("请先在源配置里填写 S3 连接信息并保存".to_string())
    })?;
    let values: Value = serde_json::from_str(&cfg.config_json).unwrap_or(Value::Null);
    let get = |k: &str| {
        values.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
    };
    let secret_map: std::collections::HashMap<String, String> =
        serde_json::from_str(&cfg.secret_ref).unwrap_or_default();
    let secret_of = |k: &str| {
        secret_map
            .get(k)
            .and_then(|vault_key| omnipanel_store::Vault::get(vault_key).ok())
            .unwrap_or_default()
    };
    let out = omnipanel_knowledge_source::SiyuanS3Config {
        endpoint: get("endpoint"),
        bucket: get("bucket"),
        region: get("region"),
        provider: get("provider"),
        access_key: get("accessKey"),
        secret_key: secret_of("secretKey"),
        repo_password: secret_of("repoPassword"),
        prefix: get("prefix"),
    };
    if out.endpoint.trim().is_empty() || out.bucket.trim().is_empty() || out.access_key.trim().is_empty() {
        return Err(OmniError::invalid_input("S3 配置不完整：请填写 Endpoint / Bucket / AccessKey".to_string()));
    }
    if out.secret_key.is_empty() || out.repo_password.is_empty() {
        return Err(OmniError::invalid_input("S3 密钥不完整：请填写 SecretKey 与数据仓库密钥".to_string()));
    }
    Ok(out)
}

fn test_counts(notebooks: Result<Vec<impl Sized>, String>, docs: Result<Vec<impl Sized>, String>, skipped: usize) -> KsTestResult {
    match (notebooks, docs) {
        (Ok(notebooks), Ok(docs)) => {
            let mut message = format!("检测到 {} 个笔记本/目录，共 {} 篇文档", notebooks.len(), docs.len());
            if skipped > 0 {
                message.push_str(&format!("（{skipped} 个超大文件跳过）"));
            }
            KsTestResult {
                ok: true,
                notebooks: notebooks.len() as i64,
                docs: docs.len() as i64,
                message,
            }
        }
        (Err(message), _) | (_, Err(message)) => KsTestResult {
            ok: false,
            notebooks: 0,
            docs: 0,
            message,
        },
    }
}

pub async fn ks_test(state: &ServerState, plugin_id: String, source_id: String) -> Result<KsTestResult, OmniError> {
    let resolved = find_source(state, &plugin_id, &source_id)?;
    let caller = GatewayCaller { state };
    if resolved.local_files {
        let root = local_root_of(state, &plugin_id, &source_id).await?;
        let adapter = omnipanel_knowledge_source::PluginLocalAdapter::new(
            &plugin_id,
            &resolved.namespace,
            &resolved.id_prefix,
            &resolved.source_prefix,
            &resolved.tag,
            &resolved.parse_method,
            root,
            resolved.file_patterns.clone(),
            caller,
        );
        let notebooks = adapter.list_notebooks().map_err(|e| e);
        let docs = adapter.list_documents().map_err(|e| e);
        return Ok(test_counts(notebooks, docs, adapter.skipped_large()));
    }
    if resolved.siyuan_s3 {
        let cfg = s3_config_of(state, &plugin_id, &source_id).await?;
        let adapter = omnipanel_knowledge_source::SiyuanS3Adapter::new(
            &plugin_id,
            &resolved.namespace,
            &resolved.id_prefix,
            &resolved.source_prefix,
            &resolved.tag,
            &resolved.parse_method,
            cfg,
            caller,
        );
        let notebooks = adapter.list_notebooks().map_err(|e| e);
        let docs = adapter.list_documents().map_err(|e| e);
        return Ok(test_counts(notebooks, docs, adapter.skipped_large()));
    }
    let extra = {
        let storage = state.storage.lock().await;
        extra_args_for(&storage, &plugin_id, &source_id, &resolved)
    };
    let adapter = PluginAdapter::new(
        &plugin_id,
        &resolved.namespace,
        &resolved.list_method,
        &resolved.get_method,
        &resolved.list_documents_method,
        caller,
    )
    .with_options(omnipanel_knowledge_source::AdapterOptions {
        id_prefix: opt_or_none(&resolved.id_prefix),
        source_prefix: opt_or_none(&resolved.source_prefix),
        tag: opt_or_none(&resolved.tag),
    })
    .with_extra_args(extra);
    let notebooks = adapter.list_notebooks().map_err(|e| e);
    let docs = adapter.list_documents().map_err(|e| e);
    Ok(test_counts(notebooks, docs, 0))
}

fn open_sync_storage() -> Result<Storage, OmniError> {
    let path = omnipanel_store::meta_db_path()
        .map_err(|e| OmniError::internal(format!("无法定位本地库: {e}")))?;
    Storage::open(&path, None).map_err(|e| OmniError::internal(format!("打开本地库失败: {e}")))
}

pub async fn ks_sync_now(state: &ServerState, plugin_id: String, source_id: String) -> Result<KsReport, OmniError> {
    run_sync(state, &plugin_id, &source_id, false).await
}

pub async fn ks_sync_rebuild(state: &ServerState, plugin_id: String, source_id: String) -> Result<KsReport, OmniError> {
    run_sync(state, &plugin_id, &source_id, true).await
}

async fn run_sync(state: &ServerState, plugin_id: &str, source_id: &str, rebuild: bool) -> Result<KsReport, OmniError> {
    let resolved = find_source(state, plugin_id, source_id)?;
    let storage = open_sync_storage()?;
    let options = omnipanel_knowledge_source::AdapterOptions {
        id_prefix: opt_or_none(&resolved.id_prefix),
        source_prefix: opt_or_none(&resolved.source_prefix),
        tag: opt_or_none(&resolved.tag),
    };
    let caller = GatewayCaller { state };
    if resolved.local_files {
        let root = local_root_of(state, plugin_id, source_id).await?;
        let adapter = omnipanel_knowledge_source::PluginLocalAdapter::new(
            plugin_id,
            &resolved.namespace,
            &options.id_prefix.clone().unwrap_or_else(|| "ks".to_string()),
            &options.source_prefix.clone().unwrap_or_else(|| format!("import:ks:{}", resolved.namespace)),
            &options.tag.clone().unwrap_or_else(|| resolved.namespace.clone()),
            &resolved.parse_method,
            root,
            resolved.file_patterns.clone(),
            caller,
        );
        return if rebuild {
            omnipanel_knowledge_source::rebuild_source(&storage, &adapter, source_id)
        } else {
            omnipanel_knowledge_source::sync_source(&storage, &adapter, source_id)
        };
    }
    if resolved.siyuan_s3 {
        let cfg = s3_config_of(state, plugin_id, source_id).await?;
        let adapter = omnipanel_knowledge_source::SiyuanS3Adapter::new(
            plugin_id,
            &resolved.namespace,
            &resolved.id_prefix,
            &resolved.source_prefix,
            &resolved.tag,
            &resolved.parse_method,
            cfg,
            caller,
        );
        return if rebuild {
            omnipanel_knowledge_source::rebuild_source(&storage, &adapter, source_id)
        } else {
            omnipanel_knowledge_source::sync_source(&storage, &adapter, source_id)
        };
    }
    let extra = extra_args_for(&storage, plugin_id, source_id, &resolved);
    let adapter = PluginAdapter::new(
        plugin_id,
        &resolved.namespace,
        &resolved.list_method,
        &resolved.get_method,
        &resolved.list_documents_method,
        caller,
    )
    .with_options(options)
    .with_extra_args(extra);
    if rebuild {
        omnipanel_knowledge_source::rebuild_source(&storage, &adapter, source_id)
    } else {
        omnipanel_knowledge_source::sync_source(&storage, &adapter, source_id)
    }
}
