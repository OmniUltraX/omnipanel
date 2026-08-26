use std::path::{Path, PathBuf};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_everything::EverythingError;
use omnipanel_mcp::plugin_tools::PluginNativeTool;
use omnipanel_mcp::{ToolExecutionKind, ToolRegistry};
use omnipanel_plugin::{
    load_installed, InvokeGateway, LogicPackage, PluginKind, PluginListItem, PluginLogicExecutor,
    PluginMethodDecl, PluginPermission, PluginPlatform, PluginRegistry, PluginSource,
};
use omnipanel_store::{AuditEntry, Storage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{Emitter, State};

use crate::state::AppState;

pub const PLUGIN_CHANGED_EVENT: &str = "plugin://changed";
pub const PLUGIN_DISCOVERY_CANCELLED_EVENT: &str = "plugin://discovery-cancelled";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginChangedPayload {
    pub plugin_id: String,
    pub enabled: bool,
    pub activated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCancelledPayload {
    pub task_id: String,
}

fn everything_err_to_omni(err: EverythingError) -> OmniError {
    match err {
        EverythingError::EmptyQuery => OmniError::invalid_input(err.to_string()),
        EverythingError::NotRunning | EverythingError::UnsupportedPlatform => {
            OmniError::connection(err.to_string())
        }
        EverythingError::Query(_) => OmniError::internal(err.to_string()),
    }
}

async fn run_everything_search(args: Value) -> Result<Value, OmniError> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let max = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(50) as u32;
    let hits = tokio::task::spawn_blocking(move || omnipanel_everything::search(&query, max))
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?
        .map_err(everything_err_to_omni)?;
    serde_json::to_value(hits).map_err(|e| OmniError::internal(e.to_string()))
}

/// 编译期内置网关 handler 登记。新增第一方插件方法在此追加，
/// 禁止在 `plugin_invoke` 命令里按插件 ID 特判。
fn register_builtin_invoke_handlers(gateway: &mut InvokeGateway) {
    gateway.register(
        omnipanel_plugin::PLUGIN_ID_ADDON_EVERYTHING,
        "omni_everything_search",
        Arc::new(|args| {
            Box::pin(async move {
                run_everything_search(args)
                    .await
                    .map_err(|e| omnipanel_plugin::PluginError::Invoke(e.to_string()))
            })
        }),
    );
}

/// L2 执行器工厂：`plugin-wasm` feature 关闭时返回 None（L1/L3 不受影响）。
pub fn make_logic_executor() -> Option<Arc<dyn PluginLogicExecutor>> {
    #[cfg(feature = "plugin-wasm")]
    let wasm: Option<Arc<dyn PluginLogicExecutor>> =
        Some(Arc::new(omnipanel_plugin_wasm::WasmExecutor::new()));
    #[cfg(not(feature = "plugin-wasm"))]
    let wasm: Option<Arc<dyn PluginLogicExecutor>> = None;

    #[cfg(feature = "plugin-js")]
    let js: Option<Arc<dyn PluginLogicExecutor>> =
        Some(Arc::new(omnipanel_plugin_js::JsExecutor::new()));
    #[cfg(not(feature = "plugin-js"))]
    let js: Option<Arc<dyn PluginLogicExecutor>> = None;

    if wasm.is_none() && js.is_none() {
        None
    } else {
        Some(Arc::new(omnipanel_plugin::RouterExecutor::new(wasm, js)))
    }
}
pub fn seed_plugin_runtime(
    storage: &Storage,
    plugins_root: Option<&Path>,
) -> (PluginRegistry, Arc<InvokeGateway>) {
    let mut registry = build_registry(plugins_root);
    if let Ok(saved) = storage.plugin_enabled_list() {
        for (id, enabled) in saved {
            let _ = registry.set_enabled(&id, enabled);
        }
    }
    registry.activate_enabled(PluginPlatform::current());
    sync_engine_plugin_gate(&registry);
    sync_plugin_engine_launches(&registry, plugins_root);
    let mut gateway = InvokeGateway::new();
    register_builtin_invoke_handlers(&mut gateway);
    (registry, Arc::new(gateway))
}

fn sync_engine_plugin_gate(registry: &PluginRegistry) {
    let disabled: Vec<String> = registry
        .list()
        .into_iter()
        .filter(|item| {
            item.kind == PluginKind::Engine
                && item.source != PluginSource::Builtin
                && (!item.enabled || !item.activated)
        })
        .map(|item| item.id)
        .collect();
    omnipanel_db::sidecar::set_disabled_engine_plugins(disabled);
}

/// 已安装 sidecar 引擎：把 `entry.driver` 登记进建连启动表（第一方引擎不走这条路径）。
fn sync_plugin_engine_launches(registry: &PluginRegistry, plugins_root: Option<&Path>) {
    let mut launches = Vec::new();
    if let Some(root) = plugins_root {
        for spec in omnipanel_plugin::collect_activated_installed_engine_drivers(registry, root) {
            match omnipanel_db::sidecar::launch_from_driver_file_result(&spec.driver_path) {
                Ok(launch) => {
                    for alias in spec.aliases {
                        if omnipanel_db::FirstPartyEngine::from_db_type(&alias).is_some() {
                            continue;
                        }
                        launches.push((alias, launch.clone()));
                    }
                }
                Err(err) => eprintln!(
                    "[plugin-engine] 跳过无法启动的 sidecar {}: {err}",
                    spec.plugin_id
                ),
            }
        }
    }
    omnipanel_db::sidecar::set_plugin_engine_launches(launches);
}

/// 内置 + 磁盘安装两来源合并构建（不含启用状态回放）。
fn build_registry(plugins_root: Option<&Path>) -> PluginRegistry {
    let mut registry = PluginRegistry::new();
    for manifest in omnipanel_plugin::first_party_manifests() {
        let _ = registry.register(manifest);
    }
    if let Some(root) = plugins_root {
        crate::commands::dbx_catalog::migrate_installed_engine_manifests(root);
        for installed in load_installed(root) {
            let _ = registry.register_installed(installed.manifest);
        }
    }
    registry
}

/// 安装/卸载后整体重建：清单来源 → 启用状态回放 → activate → 工具同步 → 事件。
pub(crate) async fn rebuild_and_sync(state: &State<'_, AppState>) -> Result<(), OmniError> {
    let mut new_registry = build_registry(state.plugin_packages_dir.as_deref());
    {
        let store = state.storage.lock().await;
        if let Ok(saved) = store.plugin_enabled_list() {
            for (id, enabled) in saved {
                let _ = new_registry.set_enabled(&id, enabled);
            }
        }
    }
    new_registry.activate_enabled(PluginPlatform::current());
    sync_engine_plugin_gate(&new_registry);
    sync_plugin_engine_launches(&new_registry, state.plugin_packages_dir.as_deref());
    for item in new_registry.list() {
        if item.kind != PluginKind::Engine || (item.enabled && item.activated) {
            continue;
        }
        if let Some(kind) = omnipanel_db::sidecar::EngineKind::from_plugin_id(&item.id) {
            omnipanel_db::sidecar::evict_all_of_kind(kind).await;
        }
    }
    {
        let mut guard = state.plugin_registry.lock().await;
        *guard = new_registry;
    }
    sync_native_plugin_tools_with_state(state).await;
    sync_plugin_logic(state).await;
    let _ = state.app_handle.emit(
        PLUGIN_CHANGED_EVENT,
        PluginChangedPayload {
            plugin_id: "__all__".into(),
            enabled: true,
            activated: true,
        },
    );
    Ok(())
}

/// L2 逻辑执行体生命周期：activated 且声明 entry.logic 的插件实例化，
/// 不再 activated 的执行体 shutdown 移除。feature 未启用时仅做清理。
pub async fn sync_plugin_logic(state: &State<'_, AppState>) {
    // 1. 收集当前应存活的 (plugin_id → logic 相对路径)
    let wanted: Vec<(String, String)> = {
        let registry = state.plugin_registry.lock().await;
        registry
            .list()
            .into_iter()
            .filter(|item| item.enabled && item.activated)
            .filter_map(|item| {
                let entry = registry.get(&item.id)?;
                entry.manifest.logic_entry().map(|p| (item.id, p.to_string()))
            })
            .collect()
    };
    let wanted_ids: std::collections::HashSet<String> =
        wanted.iter().map(|(id, _)| id.clone()).collect();

    // 2. 卸除不再存活的执行体
    {
        let mut instances = state.plugin_logic_instances.lock().unwrap();
        let stale: Vec<String> = instances
            .keys()
            .filter(|id| !wanted_ids.contains(*id))
            .cloned()
            .collect();
        for id in stale {
            if let Some(inst) = instances.remove(&id) {
                inst.lock().unwrap().shutdown();
            }
        }
    }

    // 3. 实例化新增执行体（读安装目录内的逻辑包字节）
    for (plugin_id, logic_rel) in wanted {
        {
            let instances = state.plugin_logic_instances.lock().unwrap();
            if instances.contains_key(&plugin_id) {
                continue;
            }
        }
        let Some(executor) = state.plugin_logic_executor.as_ref() else {
            continue; // feature 未启用：静默跳过（L2 调用时给出可读错误）
        };
        let Some(root) = state.plugin_packages_dir.clone() else {
            continue;
        };
        let path = root.join(&plugin_id).join(&logic_rel);
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("[plugin-logic] 读取逻辑包失败 {}: {err}", path.display());
                continue;
            }
        };
        let executor = Arc::clone(executor);
        let pid = plugin_id.clone();
        let bridge = Arc::new(crate::commands::plugin_bridge::PluginBridge {
            plugin_id: plugin_id.clone(),
            registry: Arc::clone(&state.plugin_registry),
            storage: Arc::clone(&state.storage),
            gateway: Arc::clone(&state.plugin_invoke),
            fs_root: state
                .plugin_packages_dir
                .as_ref()
                .map(|root| root.join(&plugin_id)),
            http: state.plugin_http.clone(),
            confirmer: Arc::new(crate::commands::plugin_bridge::TauriProdConfirmer {
                app: state.app_handle.clone(),
                pending: Arc::clone(&state.plugin_pending_confirms),
            }),
        });
        let package = omnipanel_plugin::LogicPackage::from_entry_bytes(&logic_rel, bytes);
        let result = tokio::task::spawn_blocking(move || executor.instantiate(&pid, &package, bridge)).await;
        match result {
            Ok(Ok(instance)) => {
                state
                    .plugin_logic_instances
                    .lock()
                    .unwrap()
                    .insert(plugin_id, Arc::new(std::sync::Mutex::new(instance)));
            }
            Ok(Err(err)) => eprintln!("[plugin-logic] 实例化失败 {plugin_id}: {err}"),
            Err(err) => eprintln!("[plugin-logic] 实例化任务失败 {plugin_id}: {err}"),
        }
    }
}
async fn sync_native_plugin_tools_with_state(state: &State<'_, AppState>) {
    let registry = state.plugin_registry.lock().await;
    let mcp = state.mcp_manager.lock().await;
    sync_native_plugin_tools(&registry, &mcp.tool_registry, &state.plugin_invoke);
}

fn pkg_err_to_omni(err: omnipanel_plugin_pkg::PkgError) -> OmniError {
    use omnipanel_plugin_pkg::PkgError as E;
    match err {
        E::BadSignature | E::UnsignedRejected => {
            OmniError::new(ErrorCode::Permission, err.to_string())
        }
        other => OmniError::invalid_input(other.to_string()),
    }
}

/// 从本地 `.omni-plugin` 文件安装（覆盖升级同 id）。release 构建仅接受官方签名；
/// dev 构建允许未签名包。安装目录：`app_data/plugins/<plugin_id>/`。
#[tauri::command]
#[specta::specta]
pub async fn plugin_install_from_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginListItem, OmniError> {
    let pkg_path = PathBuf::from(&path);
    let manifest =
        tokio::task::spawn_blocking(move || omnipanel_plugin_pkg::verify_file_dev(&pkg_path))
            .await
            .map_err(|e| OmniError::internal(e.to_string()))?
            .map_err(pkg_err_to_omni)?;
    let plugin_id = manifest.id.clone();
    let pkg_path = PathBuf::from(&path);

    {
        let registry = state.plugin_registry.lock().await;
        if !registry.is_installed(&plugin_id) && registry.get(&plugin_id).is_some() {
            return Err(OmniError::invalid_input(format!(
                "插件 id 与内置插件冲突: {plugin_id}"
            )));
        }
    }

    let dest_root = state
        .plugin_packages_dir
        .clone()
        .ok_or_else(|| OmniError::internal("无法定位插件安装目录"))?;
    let target = dest_root.join(&plugin_id);
    tokio::task::spawn_blocking(move || omnipanel_plugin_pkg::extract_to(&pkg_path, &target))
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?
        .map_err(pkg_err_to_omni)?;
    rebuild_and_sync(&state).await?;
    audit_plugin_action(
        &state,
        "plugin.install",
        &plugin_id,
        "success",
        format!("v{}", manifest.version),
    );

    let registry = state.plugin_registry.lock().await;
    let entry = registry
        .get(&plugin_id)
        .ok_or_else(|| OmniError::not_found(format!("未知插件: {plugin_id}")))?;
    Ok(PluginListItem {
        id: entry.manifest.id.clone(),
        version: entry.manifest.version.clone(),
        kind: entry.manifest.kind,
        enabled: entry.enabled,
        activated: entry.activated,
        source: entry.source,
        unsupported_reason: entry.unsupported_reason.clone(),
    })
}

/// 卸载磁盘安装的插件：删除安装目录与启用记录；内置插件拒绝卸载。
#[tauri::command]
#[specta::specta]
pub async fn plugin_uninstall(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<(), OmniError> {
    {
        let registry = state.plugin_registry.lock().await;
        if !registry.is_installed(&plugin_id) {
            return Err(OmniError::invalid_input(format!(
                "内置插件不可卸载，仅可禁用: {plugin_id}"
            )));
        }
    }
    if let Some(dest_root) = state.plugin_packages_dir.clone() {
        let target = dest_root.join(&plugin_id);
        tokio::task::spawn_blocking(move || {
            if target.exists() {
                std::fs::remove_dir_all(&target)
            } else {
                Ok(())
            }
        })
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?
        .map_err(|e| OmniError::internal(e.to_string()))?;
    }
    {
        let store = state.storage.lock().await;
        store.plugin_enabled_delete(&plugin_id)?;
    }
    audit_plugin_action(&state, "plugin.uninstall", &plugin_id, "success", String::new());
    rebuild_and_sync(&state).await?;
    omnipanel_db::sidecar::evict_all_external_launches().await;
    Ok(())
}

/// AI Native 工具泛化同步：以 activated manifests 的 `contributes.ai.tools`
/// 为唯一事实源全量重建；executor 统一经 `(plugin_id, tool.name)` 网关分发。
pub fn sync_native_plugin_tools(
    registry: &PluginRegistry,
    tools: &ToolRegistry,
    gateway: &Arc<InvokeGateway>,
) {
    omnipanel_mcp::plugin_tools::global_plugin_tool_hub().clear();
    for (plugin_id, tool) in &registry.contributions().ai_tools {
        let method_name = tool.name.clone();
        let gw = Arc::clone(gateway);
        let pid = plugin_id.clone();
        tools.register_plugin_native_tool(PluginNativeTool {
            plugin_id: plugin_id.clone(),
            name: tool.name.clone(),
            module_key: tool.module_key.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
            kind: ToolExecutionKind::Native,
            cross_module: tool.cross_module,
            external_exposed: tool.external_exposed,
            executor: Arc::new(move |_name, args| {
                let gw = Arc::clone(&gw);
                let pid = pid.clone();
                let method = method_name.clone();
                Box::pin(async move {
                    gw.invoke(&pid, &method, args)
                        .await
                        .map(|value| (value.to_string(), false))
                        .map_err(|e| e.to_string())
                })
            }),
        });
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// args 只存摘要（sha256 + 长度），不落原文，避免密钥入审计库。
fn args_digest(args: &Value) -> String {
    let serialized = serde_json::to_string(args).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    format!("sha256:{:x} len={}", hasher.finalize(), serialized.len())
}

fn audit_plugin_action(state: &AppState, action: &str, target: &str, status: &str, detail: String) {
    let entry = AuditEntry {
        ts: now_ms(),
        action: action.to_string(),
        target: target.to_string(),
        env_tag: "-".into(),
        risk: "medium".into(),
        status: status.to_string(),
        detail: detail.chars().take(200).collect(),
    };
    if let Ok(store) = state.storage.try_lock() {
        let _ = store.append_audit(&entry);
    }
}

/// 列出已编译的第一方插件（含未激活的平台不匹配项）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginListItem>, OmniError> {
    let registry = state.plugin_registry.lock().await;
    Ok(registry.list())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestDto {
    pub id: String,
    pub version: String,
    pub kind: omnipanel_plugin::PluginKind,
    pub enabled: bool,
    pub activated: bool,
    pub source: PluginSource,
    /// 清单原文（JSON 字符串）：规避 specta 对内嵌 Value 的递归内联展开；
    /// 前端以 plugin-sdk Zod schema 解析，保持清单合同单源。
    pub manifest_json: String,
}

/// 全量清单（内置 + 已安装）：前端 PluginCatalog 单源合并用。
#[tauri::command]
#[specta::specta]
pub async fn plugin_manifests(
    state: State<'_, AppState>,
) -> Result<Vec<PluginManifestDto>, OmniError> {
    let registry = state.plugin_registry.lock().await;
    Ok(registry
        .list()
        .into_iter()
        .filter_map(|item| {
            let entry = registry.get(&item.id)?;
            Some(PluginManifestDto {
                manifest_json: serde_json::to_string(&entry.manifest)
                    .unwrap_or_else(|_| "{}".into()),
                id: item.id,
                version: item.version,
                kind: item.kind,
                enabled: item.enabled,
                activated: item.activated,
                source: item.source,
            })
        })
        .collect())
}

/// 启用或禁用插件。禁用后卸除贡献点（含 AI 工具），连接数据保留。
#[tauri::command]
#[specta::specta]
pub async fn plugin_set_enabled(
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginListItem, OmniError> {
    {
        let registry = state.plugin_registry.lock().await;
        let Some(entry) = registry.get(&plugin_id) else {
            return Err(OmniError::not_found(format!("未知插件: {plugin_id}")));
        };
        if !enabled && entry.always_on() {
            return Err(OmniError::invalid_input(format!(
                "内置数据库引擎不可关闭: {plugin_id}"
            )));
        }
    }
    {
        let store = state.storage.lock().await;
        store.plugin_enabled_set(&plugin_id, enabled)?;
    }
    {
        let mut registry = state.plugin_registry.lock().await;
        registry.set_enabled(&plugin_id, enabled)?;
        sync_engine_plugin_gate(&registry);
        sync_plugin_engine_launches(&registry, state.plugin_packages_dir.as_deref());
    }
    if !enabled {
        if let Some(kind) = omnipanel_db::sidecar::EngineKind::from_plugin_id(&plugin_id) {
            omnipanel_db::sidecar::evict_all_of_kind(kind).await;
        }
    }
    {
        let registry = state.plugin_registry.lock().await;
        let mcp = state.mcp_manager.lock().await;
        sync_native_plugin_tools(&registry, &mcp.tool_registry, &state.plugin_invoke);
    }
    sync_plugin_logic(&state).await;
    let item = {
        let registry = state.plugin_registry.lock().await;
        let entry = registry
            .get(&plugin_id)
            .ok_or_else(|| OmniError::not_found(format!("未知插件: {plugin_id}")))?;
        PluginListItem {
            id: entry.manifest.id.clone(),
            version: entry.manifest.version.clone(),
            kind: entry.manifest.kind,
            enabled: entry.enabled,
            activated: entry.activated,
            source: entry.source,
            unsupported_reason: entry.unsupported_reason.clone(),
        }
    };
    let _ = state.app_handle.emit(
        PLUGIN_CHANGED_EVENT,
        PluginChangedPayload {
            plugin_id: item.id.clone(),
            enabled: item.enabled,
            activated: item.activated,
        },
    );
    Ok(item)
}

/// 第一方/第三方统一命令网关：清单 `methods[]` 白名单 + 权限注解强制 + 审计。
#[tauri::command]
#[specta::specta]
pub async fn plugin_invoke(
    state: State<'_, AppState>,
    plugin_id: String,
    method: String,
    args: Value,
) -> Result<Value, OmniError> {
    // 1. 白名单：未声明 method 一律拒绝（含未激活插件）
    let decl: PluginMethodDecl = {
        let registry = state.plugin_registry.lock().await;
        registry.declared_method(&plugin_id, &method)?
    };
    // 2. 权限：逐项强制，缺权即失败
    {
        let registry = state.plugin_registry.lock().await;
        for permission in &decl.permissions {
            registry.require_permission(&plugin_id, *permission)?;
        }
    }
    // 3a. 原生网关优先
    let native = state
        .plugin_invoke
        .invoke(&plugin_id, &method, args.clone())
        .await;
    // 3b. 原生未登记 → L2 逻辑执行体兜底（权限已在步骤 2 强制）
    let result = match native {
        Err(omnipanel_plugin::PluginError::UnknownMethod { .. }) => {
            let instance = {
                let instances = state.plugin_logic_instances.lock().unwrap();
                instances.get(&plugin_id).cloned()
            };
            match instance {
                Some(instance) => {
                    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "{}".into());
                    let method = method.clone();
                    tokio::task::spawn_blocking(move || {
                        let mut guard = instance.lock().unwrap();
                        let rt = tokio::runtime::Handle::current();
                        rt.block_on(guard.call(&method, &args_json))
                    })
                    .await
                    .map_err(|e| OmniError::internal(e.to_string()))?
                    .and_then(|text| {
                        serde_json::from_str::<Value>(&text).map_err(|e| {
                            omnipanel_plugin::PluginError::Invoke(format!("L2 结果非 JSON: {e}"))
                        })
                    })
                }
                None => Err(omnipanel_plugin::PluginError::UnknownMethod {
                    plugin_id: plugin_id.clone(),
                    method: method.clone(),
                }),
            }
        }
        other => other,
    };
    let status = if result.is_ok() { "success" } else { "failed" };
    let detail = match &result {
        Ok(_) => format!("{method} {}", args_digest(&args)),
        Err(err) => format!("{method} {} err={err}", args_digest(&args)),
    };
    audit_plugin_action(&state, "plugin.invoke", &plugin_id, status, detail);
    result.map_err(Into::into)
}

/// 缺权即失败。前端 Host API 在 upsert / 选区 / SSH 探测前必须先过此闸；
/// 拒绝写入审计（action=plugin.permission，status=blocked）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_require_permission(
    state: State<'_, AppState>,
    plugin_id: String,
    permission: String,
) -> Result<(), OmniError> {
    let perm = PluginPermission::parse(&permission)?;
    let outcome = {
        let registry = state.plugin_registry.lock().await;
        registry.require_permission(&plugin_id, perm)
    };
    if let Err(err) = &outcome {
        audit_plugin_action(
            &state,
            "plugin.permission",
            &plugin_id,
            "blocked",
            format!("{permission}: {err}"),
        );
    }
    outcome.map_err(Into::into)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryScope {
    #[serde(default)]
    pub host_ids: Vec<String>,
    #[serde(default)]
    pub env_tag: Option<String>,
}

/// 发现总线：任务中心登记、进度与取消令牌。真实 probe 在前端执行。
///
/// 内核 probe：`ssh-docker`（SSH 扫 Docker）、`ssh-panel`（SSH 扫面板）。
/// prod 主机过滤在前端 `sshDiscoveryScope`；本命令不因 `env_tag` 走占位分支。
#[tauri::command]
#[specta::specta]
pub async fn discovery_run(
    state: State<'_, AppState>,
    probe_id: String,
    scope: DiscoveryScope,
) -> Result<String, OmniError> {
    if probe_id.trim().is_empty() {
        return Err(OmniError::invalid_input("probe_id 不能为空"));
    }
    let title = format!("发现 {probe_id}");
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();
    let total = scope.host_ids.len().max(1) as u32;

    pool.spawn(
        app.clone(),
        "server",
        "pluginDiscovery",
        title,
        total,
        move |task_id, cancel, progress| async move {
            let emit_cancelled = || {
                let _ = app.emit(
                    PLUGIN_DISCOVERY_CANCELLED_EVENT,
                    DiscoveryCancelledPayload {
                        task_id: task_id.clone(),
                    },
                );
            };
            progress(format!("probe={probe_id}"), 0, total, None, None);
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                emit_cancelled();
                return Err("已取消".into());
            }
            for (i, host) in scope.host_ids.iter().enumerate() {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    emit_cancelled();
                    return Err("已取消".into());
                }
                progress(format!("host={host}"), (i + 1) as u32, total, None, None);
            }
            if scope.host_ids.is_empty() {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    emit_cancelled();
                    return Err("已取消".into());
                }
                progress("无主机，跳过".into(), 1, 1, None, None);
            }
            Ok(())
        },
    )
    .await
}

/// prod 确认回传：前端弹窗结果 → 唤醒等待中的桥调用。
#[tauri::command]
#[specta::specta]
pub async fn plugin_confirm_resolve(
    state: State<'_, AppState>,
    request_id: String,
    allow: bool,
) -> Result<(), OmniError> {
    let sender = state.plugin_pending_confirms.lock().await.remove(&request_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(allow);
            Ok(())
        }
        None => Err(OmniError::not_found(format!(
            "确认请求不存在或已超时: {request_id}"
        ))),
    }
}
/// 读取已安装插件的文本资产（L3 沙箱 UI 用）。仅限包目录内、文本类扩展、≤512KB。
#[tauri::command]
#[specta::specta]
pub async fn plugin_read_asset(
    state: State<'_, AppState>,
    plugin_id: String,
    rel_path: String,
) -> Result<String, OmniError> {
    let root = state
        .plugin_packages_dir
        .clone()
        .ok_or_else(|| OmniError::internal("无法定位插件安装目录"))?;
    let base = root.join(&plugin_id);
    let target = base.join(&rel_path);
    let lower = rel_path.to_ascii_lowercase();
    let allowed_ext = ["html", "htm", "css", "txt", "json"];
    if !lower.rsplit('.').next().map_or(false, |ext| allowed_ext.contains(&ext)) {
        return Err(OmniError::invalid_input(format!("不支持的资产类型: {rel_path}")));
    }
    if !target.starts_with(&base) {
        return Err(OmniError::invalid_input("路径越界"));
    }
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|_| OmniError::not_found(format!("资产不存在: {rel_path}")))?;
    if meta.len() > 512 * 1024 {
        return Err(OmniError::invalid_input("资产超过 512KB 上限"));
    }
    let text = tokio::fs::read_to_string(&target)
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?;
    Ok(text)
}

/// 沙箱 UI 专用的受限网络访问：与 L2 桥同源权限闸 + prod 确认。
#[tauri::command]
#[specta::specta]
pub async fn plugin_sandbox_net_fetch(
    state: State<'_, AppState>,
    plugin_id: String,
    spec_json: String,
) -> Result<String, OmniError> {
    // 权限前置：net:connect
    {
        let registry = state.plugin_registry.lock().await;
        registry.require_permission(&plugin_id, omnipanel_plugin::PluginPermission::NetConnect)?;
    }
    let bridge = crate::commands::plugin_bridge::PluginBridge {
        plugin_id,
        registry: Arc::clone(&state.plugin_registry),
        storage: Arc::clone(&state.storage),
        gateway: Arc::clone(&state.plugin_invoke),
        fs_root: None,
        http: state.plugin_http.clone(),
        confirmer: Arc::new(crate::commands::plugin_bridge::TauriProdConfirmer {
            app: state.app_handle.clone(),
            pending: Arc::clone(&state.plugin_pending_confirms),
        }),
    };
    // 同步桥放阻塞任务（经 PluginHostBridge trait 调用）
    use omnipanel_plugin::PluginHostBridge as _;
    tokio::task::spawn_blocking(move || bridge.net_fetch(&spec_json))
        .await
        .map_err(|e: tokio::task::JoinError| OmniError::internal(e.to_string()))?
        .map_err(OmniError::invalid_input)
}