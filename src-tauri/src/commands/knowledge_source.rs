//! 知识源管线（`kind: knowledge`）宿主命令：插件只读供数，落库由宿主引擎负责。
//!
//! 通用同步控制台 UI 后置；当前经 IPC/MCP 直接调用。
//!
//! 并发说明：引擎跑在独立 `Storage` 句柄上（同一 DB 文件，WAL 并发），
//! 避免占用 `state.storage` 异步锁时插件回调（vault 等）形成锁重入死锁。

use omnipanel_error::OmniError;
use omnipanel_knowledge_source::{KsReport, MethodCaller, PluginAdapter, SourceAdapter};
use omnipanel_store::{KsSourceConfig, Storage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::plugin::invoke_plugin_method;
use crate::state::AppState;

/// 知识源描述（控制台展示用）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KsSourceDecl {
    pub plugin_id: String,
    pub source_id: String,
    pub title: String,
    pub formats: Vec<String>,
    pub has_search: bool,
    pub fields: Vec<KsSourceField>,
}

/// 源配置表单字段（`importerFieldSchema` 子集，展示用）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KsSourceField {
    pub key: String,
    pub kind: String,
    pub label: String,
    pub placeholder: String,
    pub required: bool,
}

fn parse_fields(source: &Value) -> Vec<KsSourceField> {
    source
        .get("fields")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    Some(KsSourceField {
                        key: f.get("key")?.as_str()?.to_string(),
                        kind: f
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("text")
                            .to_string(),
                        label: f
                            .get("label")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        placeholder: f
                            .get("placeholder")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        required: f.get("required").and_then(|v| v.as_bool()).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 测试连接结果。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KsTestResult {
    pub ok: bool,
    pub notebooks: i64,
    pub docs: i64,
    pub message: String,
}

/// 同步状态。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KsStatus {
    pub last_sync_at: i64,
    pub report: Option<KsReport>,
}

fn source_key_of(plugin_id: &str, source_id: &str) -> String {
    format!("plugin:{plugin_id}:{source_id}")
}

fn opt_or_none(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn str_field(source: &Value, key: &str) -> String {
    source
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn find_source_methods(
    manifest: &omnipanel_plugin::PluginManifest,
    plugin_id: &str,
    source_id: &str,
) -> Result<ResolvedSource, OmniError> {
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
        // 思源 S3 源：宿主原生 dejavu 拉取 + parseMethod 解析，不调 list/get。
        let siyuan_s3 = source
            .get("siyuanS3")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let namespace = str_field(source, "id");
        let tag = {
            let tag = str_field(source, "tag");
            if tag.is_empty() {
                namespace.clone()
            } else {
                tag
            }
        };
        let mut fields = Vec::new();
        if let Some(arr) = source.get("fields").and_then(|v| v.as_array()) {
            for field in arr {
                let key = field
                    .get("key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if key.is_empty() {
                    continue;
                }
                let str_or = |k: &str, default: &str| {
                    field
                        .get(k)
                        .and_then(|v| v.as_str())
                        .unwrap_or(default)
                        .to_string()
                };
                fields.push(KsSourceField {
                    key: key.to_string(),
                    kind: str_or("kind", "text"),
                    label: str_or("label", ""),
                    placeholder: str_or("placeholder", ""),
                    required: field
                        .get("required")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                });
            }
        }
        let resolved = ResolvedSource {
            namespace,
            title: str_field(source, "title"),
            list_method: str_field(source, "listMethod"),
            list_documents_method: str_field(source, "listDocumentsMethod"),
            get_method: str_field(source, "getMethod"),
            local_files,
            siyuan_s3,
            parse_method: str_field(source, "parseMethod"),
            file_patterns: source
                .get("filePatterns")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            id_prefix: {
                let prefix = str_field(source, "idPrefix");
                if prefix.is_empty() {
                    "ks".to_string()
                } else {
                    prefix
                }
            },
            source_prefix: {
                let prefix = str_field(source, "sourcePrefix");
                if prefix.is_empty() {
                    "import:ks".to_string()
                } else {
                    prefix
                }
            },
            tag,
            fields,
        };
        if local_files {
            if resolved.parse_method.is_empty() {
                return Err(OmniError::invalid_input(format!(
                    "知识源声明 localFiles 必须配 parseMethod: {source_id}"
                )));
            }
            return Ok(resolved);
        }
        if siyuan_s3 {
            if resolved.parse_method.is_empty() {
                return Err(OmniError::invalid_input(format!(
                    "知识源声明 siyuanS3 必须配 parseMethod: {source_id}"
                )));
            }
            return Ok(resolved);
        }
        if resolved.list_method.is_empty()
            || resolved.list_documents_method.is_empty()
            || resolved.get_method.is_empty()
        {
            return Err(OmniError::invalid_input(format!(
                "知识源缺少 list/listDocuments/get 方法声明: {source_id}"
            )));
        }
        return Ok(resolved);
    }
    Err(OmniError::not_found(format!(
        "插件未声明该知识源: {source_id}"
    )))
}

/// 解析后的源声明（构造适配器用）。
struct ResolvedSource {
    namespace: String,
    #[allow(dead_code)]
    title: String,
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

fn manifest_of(
    registry: &omnipanel_plugin::PluginRegistry,
    plugin_id: &str,
) -> Result<omnipanel_plugin::PluginManifest, OmniError> {
    let entry = registry
        .get(plugin_id)
        .ok_or_else(|| OmniError::not_found(format!("未知插件: {plugin_id}")))?;
    if !entry.enabled {
        return Err(OmniError::invalid_input(format!("插件未启用: {plugin_id}")));
    }
    Ok(entry.manifest.clone())
}

/// 网关调用桥接（同步契约内跑异步网关；命令本就跑在多线程 runtime）。
struct GatewayCaller<'a> {
    state: &'a AppState,
    plugin_id: String,
}

impl MethodCaller for GatewayCaller<'_> {
    fn call(&self, plugin_id: &str, method: &str, args: Value) -> Result<Value, String> {
        debug_assert_eq!(plugin_id, self.plugin_id);
        let plugin_id = plugin_id.to_string();
        let method = method.to_string();
        tokio::task::block_in_place(move || {
            tokio::runtime::Handle::current()
                .block_on(
                    async move { invoke_plugin_method(self.state, plugin_id, method, args).await },
                )
                .map_err(|e| e.to_string())
        })
    }
}

/// 独立 Storage 句柄（与 state.storage 同一 DB 文件，WAL 并发）。
fn open_sync_storage() -> Result<Storage, OmniError> {
    let path = omnipanel_store::meta_db_path()
        .map_err(|e| OmniError::internal(format!("无法定位本地库: {e}")))?;
    Storage::open(&path, None).map_err(|e| OmniError::internal(format!("打开本地库失败: {e}")))
}

/// 列出某插件声明的知识源（控制台用）。
#[tauri::command]
#[specta::specta]
pub async fn ks_sources_of(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<Vec<KsSourceDecl>, OmniError> {
    let manifest = {
        let registry = state.plugin_registry.lock().await;
        manifest_of(&registry, &plugin_id)?
    };
    if manifest.kind != omnipanel_plugin::PluginKind::Knowledge {
        return Err(OmniError::invalid_input(format!(
            "插件不是 knowledge kind: {plugin_id}"
        )));
    }
    let mut out = Vec::new();
    for source in &manifest.contributes.knowledge_sources {
        let id = str_field(source, "id");
        if id.is_empty() {
            continue;
        }
        out.push(KsSourceDecl {
            plugin_id: plugin_id.clone(),
            source_id: id,
            title: str_field(source, "title"),
            formats: source
                .get("formats")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            has_search: !str_field(source, "searchMethod").is_empty(),
            fields: parse_fields(source),
        });
    }
    Ok(out)
}

/// 读取某源配置（无配置返回 None，由控制台填默认）。
#[tauri::command]
#[specta::specta]
pub async fn ks_config_get(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
) -> Result<Option<KsSourceConfig>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ks_config_get(&source_key_of(&plugin_id, &source_id))
}

/// 保存某源配置（`config_json` 必须为合法 JSON；密钥走 Vault，不落库）。
#[tauri::command]
#[specta::specta]
pub async fn ks_config_save(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
    display_name: String,
    config_json: String,
) -> Result<(), OmniError> {
    serde_json::from_str::<Value>(&config_json)
        .map_err(|e| OmniError::invalid_input(format!("配置不是合法 JSON: {e}")))?;
    let storage = state.storage.lock().await;
    let key = source_key_of(&plugin_id, &source_id);
    let mut cfg = storage.ks_config_get(&key)?.unwrap_or(KsSourceConfig {
        source_key: key.clone(),
        display_name: display_name.clone(),
        adapter: "plugin".to_string(),
        config_json: "{}".to_string(),
        secret_ref: String::new(),
        last_sync_at: 0,
        last_report_json: String::new(),
    });
    cfg.display_name = display_name;
    cfg.config_json = config_json;
    storage.ks_config_save(&cfg)
}

/// 保存某源密钥字段（进 Vault；`secret_ref` 存 `{"fieldKey": "vaultKey"}`）。
/// 框定键名 `ks-{sourceId}-{fieldKey}`，与 importer 的 secretKeyFor 同构。
#[tauri::command]
#[specta::specta]
pub async fn ks_secret_save(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
    field_key: String,
    secret: String,
) -> Result<(), OmniError> {
    if secret.trim().is_empty() {
        return Err(OmniError::invalid_input("密钥不能为空".to_string()));
    }
    let vault_key = format!("ks-{}-{}", source_id.trim(), field_key.trim());
    crate::commands::plugin::require_plugin_vault(&state, &plugin_id).await?;
    let reference = omnipanel_store::plugin_secret_ref(&plugin_id, &vault_key)
        .map_err(|e| OmniError::internal(format!("生成密钥引用失败: {e}")))?;
    omnipanel_store::Vault::store(&reference, secret.trim())?;
    let storage = state.storage.lock().await;
    let key = source_key_of(&plugin_id, &source_id);
    let mut cfg = storage.ks_config_get(&key)?.unwrap_or(KsSourceConfig {
        source_key: key.clone(),
        display_name: source_id.clone(),
        adapter: "plugin".to_string(),
        config_json: "{}".to_string(),
        secret_ref: String::new(),
        last_sync_at: 0,
        last_report_json: String::new(),
    });
    let mut refs: std::collections::HashMap<String, String> =
        serde_json::from_str(&cfg.secret_ref).unwrap_or_default();
    refs.insert(field_key, vault_key);
    cfg.secret_ref = serde_json::to_string(&refs).unwrap_or_default();
    storage.ks_config_save(&cfg)
}

/// 某密钥字段是否已存（不回显值）。
#[tauri::command]
#[specta::specta]
pub async fn ks_secret_has(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
    field_key: String,
) -> Result<bool, OmniError> {
    let storage = state.storage.lock().await;
    let key = source_key_of(&plugin_id, &source_id);
    let refs: std::collections::HashMap<String, String> = storage
        .ks_config_get(&key)?
        .map(|cfg| serde_json::from_str(&cfg.secret_ref).unwrap_or_default())
        .unwrap_or_default();
    let Some(vault_key) = refs.get(&field_key) else {
        return Ok(false);
    };
    let reference = omnipanel_store::plugin_secret_ref(&plugin_id, vault_key)
        .map_err(|e| OmniError::internal(format!("生成密钥引用失败: {e}")))?;
    Ok(omnipanel_store::Vault::get(&reference)
        .map(|s| !s.is_empty())
        .unwrap_or(false))
}

/// 测试连接：local 源走 walk 计数，远程源调 list 方法计数。
#[tauri::command]
#[specta::specta]
pub async fn ks_test(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
) -> Result<KsTestResult, OmniError> {
    let resolved = {
        let registry = state.plugin_registry.lock().await;
        let manifest = manifest_of(&registry, &plugin_id)?;
        find_source_methods(&manifest, &plugin_id, &source_id)?
    };
    if resolved.local_files {
        let root = local_root_of(&state, &plugin_id, &source_id).await?;
        let caller = GatewayCaller {
            state: &state,
            plugin_id: plugin_id.clone(),
        };
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
        let notebooks = adapter
            .list_notebooks()
            .map_err(|e| OmniError::internal(e).to_string());
        let docs = adapter
            .list_documents()
            .map_err(|e| OmniError::internal(e).to_string());
        return match (notebooks, docs) {
            (Ok(notebooks), Ok(docs)) => {
                let mut message = format!(
                    "检测到 {} 个笔记本/目录，共 {} 篇文档",
                    notebooks.len(),
                    docs.len()
                );
                let skipped = adapter.skipped_large();
                if skipped > 0 {
                    message.push_str(&format!("（{skipped} 个超大文件跳过）"));
                }
                Ok(KsTestResult {
                    ok: true,
                    notebooks: notebooks.len() as i64,
                    docs: docs.len() as i64,
                    message,
                })
            }
            (Err(message), _) | (_, Err(message)) => Ok(KsTestResult {
                ok: false,
                notebooks: 0,
                docs: 0,
                message,
            }),
        };
    }
    if resolved.siyuan_s3 {
        let cfg = s3_config_of(&state, &plugin_id, &source_id).await?;
        let caller = GatewayCaller {
            state: &state,
            plugin_id: plugin_id.clone(),
        };
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
        let notebooks = adapter
            .list_notebooks()
            .map_err(|e| OmniError::internal(e).to_string());
        let docs = adapter
            .list_documents()
            .map_err(|e| OmniError::internal(e).to_string());
        return match (notebooks, docs) {
            (Ok(notebooks), Ok(docs)) => {
                let mut message = format!(
                    "检测到 {} 个笔记本/目录，共 {} 篇文档",
                    notebooks.len(),
                    docs.len()
                );
                let skipped = adapter.skipped_large();
                if skipped > 0 {
                    message.push_str(&format!("（{skipped} 个超大/损坏文件跳过）"));
                }
                Ok(KsTestResult {
                    ok: true,
                    notebooks: notebooks.len() as i64,
                    docs: docs.len() as i64,
                    message,
                })
            }
            (Err(message), _) | (_, Err(message)) => Ok(KsTestResult {
                ok: false,
                notebooks: 0,
                docs: 0,
                message,
            }),
        };
    }
    let caller = GatewayCaller {
        state: &state,
        plugin_id: plugin_id.clone(),
    };
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
    let notebooks = adapter
        .list_notebooks()
        .map_err(|e| OmniError::internal(e).to_string());
    let docs = adapter
        .list_documents()
        .map_err(|e| OmniError::internal(e).to_string());
    match (notebooks, docs) {
        (Ok(notebooks), Ok(docs)) => Ok(KsTestResult {
            ok: true,
            notebooks: notebooks.len() as i64,
            docs: docs.len() as i64,
            message: format!(
                "检测到 {} 个笔记本/目录，共 {} 篇文档",
                notebooks.len(),
                docs.len()
            ),
        }),
        (Err(message), _) | (_, Err(message)) => Ok(KsTestResult {
            ok: false,
            notebooks: 0,
            docs: 0,
            message,
        }),
    }
}

/// 方法底包参数：ks 配置值 + Vault 密钥（调用方特定键优先）。
/// `secret_ref` 存 `{"fieldKey": "vaultKey"}` JSON；缺失/读失败的密钥直接跳过
/// （插件侧拿到空缺键，自行报错，比把空字符串当密钥更诚实）。
fn extra_args_for(
    storage: &omnipanel_store::Storage,
    plugin_id: &str,
    source_id: &str,
    resolved: &ResolvedSource,
) -> Value {
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

/// ks 配置里的本地根目录（`rootPath`），校验存在且为目录。
async fn local_root_of(
    state: &State<'_, AppState>,
    plugin_id: &str,
    source_id: &str,
) -> Result<std::path::PathBuf, OmniError> {
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
        return Err(OmniError::invalid_input(
            "请先在源配置里填写本地根目录（rootPath）".to_string(),
        ));
    }
    let path = std::path::PathBuf::from(root.trim());
    if !path.is_dir() {
        return Err(OmniError::invalid_input(format!(
            "本地根目录不存在或不可读: {}",
            path.display()
        )));
    }
    Ok(path)
}

/// 思源 S3 源配置（表单值 + Vault 密钥拼装）。
async fn s3_config_of(
    state: &State<'_, AppState>,
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
        values
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
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
    if out.endpoint.trim().is_empty()
        || out.bucket.trim().is_empty()
        || out.access_key.trim().is_empty()
    {
        return Err(OmniError::invalid_input(
            "S3 配置不完整：请填写 Endpoint / Bucket / AccessKey".to_string(),
        ));
    }
    if out.secret_key.is_empty() || out.repo_password.is_empty() {
        return Err(OmniError::invalid_input(
            "S3 密钥不完整：请填写 SecretKey 与数据仓库密钥".to_string(),
        ));
    }
    Ok(out)
}

/// 手动同步一次。
#[tauri::command]
#[specta::specta]
pub async fn ks_sync_now(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
) -> Result<KsReport, OmniError> {
    run_ks_sync(&state, &plugin_id, &source_id, false).await
}

/// 重建同步：清空该源文件状态后全量重评。
#[tauri::command]
#[specta::specta]
pub async fn ks_sync_rebuild(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
) -> Result<KsReport, OmniError> {
    run_ks_sync(&state, &plugin_id, &source_id, true).await
}

async fn run_ks_sync(
    state: &State<'_, AppState>,
    plugin_id: &str,
    source_id: &str,
    rebuild: bool,
) -> Result<KsReport, OmniError> {
    let resolved = {
        let registry = state.plugin_registry.lock().await;
        let manifest = manifest_of(&registry, plugin_id)?;
        find_source_methods(&manifest, plugin_id, source_id)?
    };
    let storage = open_sync_storage()?;
    let options = omnipanel_knowledge_source::AdapterOptions {
        id_prefix: opt_or_none(&resolved.id_prefix),
        source_prefix: opt_or_none(&resolved.source_prefix),
        tag: opt_or_none(&resolved.tag),
    };
    if resolved.local_files {
        let root = local_root_of(state, plugin_id, source_id).await?;
        let caller = GatewayCaller {
            state,
            plugin_id: plugin_id.to_string(),
        };
        let adapter = omnipanel_knowledge_source::PluginLocalAdapter::new(
            plugin_id,
            &resolved.namespace,
            &options
                .id_prefix
                .clone()
                .unwrap_or_else(|| "ks".to_string()),
            &options
                .source_prefix
                .clone()
                .unwrap_or_else(|| format!("import:ks:{}", resolved.namespace)),
            &options
                .tag
                .clone()
                .unwrap_or_else(|| resolved.namespace.clone()),
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
        let caller = GatewayCaller {
            state,
            plugin_id: plugin_id.to_string(),
        };
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
    let caller = GatewayCaller {
        state,
        plugin_id: plugin_id.to_string(),
    };
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

/// 同步状态（上次时间 + 上次报告）。
#[tauri::command]
#[specta::specta]
pub async fn ks_status(
    state: State<'_, AppState>,
    plugin_id: String,
    source_id: String,
) -> Result<KsStatus, OmniError> {
    let storage = state.storage.lock().await;
    let cfg = storage.ks_config_get(&source_key_of(&plugin_id, &source_id))?;
    let report = if cfg
        .as_ref()
        .map(|c| c.last_report_json.trim().is_empty())
        .unwrap_or(true)
    {
        None
    } else {
        cfg.as_ref()
            .and_then(|c| serde_json::from_str(&c.last_report_json).ok())
    };
    Ok(KsStatus {
        last_sync_at: cfg.map(|c| c.last_sync_at).unwrap_or(0),
        report,
    })
}
