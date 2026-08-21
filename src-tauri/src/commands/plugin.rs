use omnipanel_error::OmniError;
use omnipanel_everything::EverythingError;
use omnipanel_mcp::plugin_tools::PluginNativeTool;
use omnipanel_mcp::{ToolExecutionKind, ToolRegistry};
use omnipanel_plugin::{
    first_party_manifests, InvokeGateway, PluginListItem, PluginPermission, PluginPlatform,
    PluginRegistry, PLUGIN_ID_ADDON_EVERYTHING,
};
use omnipanel_store::Storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

pub fn seed_plugin_runtime(storage: &Storage) -> (PluginRegistry, InvokeGateway) {
    let mut registry = PluginRegistry::new();
    for manifest in first_party_manifests() {
        let _ = registry.register(manifest);
    }
    if let Ok(saved) = storage.plugin_enabled_list() {
        for (id, enabled) in saved {
            let _ = registry.set_enabled(&id, enabled);
        }
    }
    registry.activate_enabled(PluginPlatform::current());
    (registry, InvokeGateway::new())
}

pub fn sync_native_plugin_tools(registry: &PluginRegistry, tools: &ToolRegistry) {
    tools.unregister_plugin_tools(PLUGIN_ID_ADDON_EVERYTHING);
    let Some(entry) = registry.get(PLUGIN_ID_ADDON_EVERYTHING) else {
        return;
    };
    if !entry.activated {
        return;
    }
    tools.register_plugin_native_tool(PluginNativeTool {
        plugin_id: PLUGIN_ID_ADDON_EVERYTHING.into(),
        name: "omni_everything_search".into(),
        module_key: "files".into(),
        description: "用 Everything 搜索本机文件路径（仅元数据，不含文件内容）".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "max_results": { "type": "integer", "default": 50 }
            },
            "required": ["query"]
        }),
        kind: ToolExecutionKind::Native,
        cross_module: true,
        external_exposed: false,
        executor: std::sync::Arc::new(|_name, args| {
            Box::pin(async move {
                let value = run_everything_search(args)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok((value.to_string(), false))
            })
        }),
    });
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

/// 列出已编译的第一方插件（含未激活的平台不匹配项）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginListItem>, OmniError> {
    let registry = state.plugin_registry.lock().await;
    Ok(registry.list())
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
        if registry.get(&plugin_id).is_none() {
            return Err(OmniError::not_found(format!("未知插件: {plugin_id}")));
        }
    }
    {
        let store = state.storage.lock().await;
        store.plugin_enabled_set(&plugin_id, enabled)?;
    }
    {
        let mut registry = state.plugin_registry.lock().await;
        registry.set_enabled(&plugin_id, enabled)?;
    }
    {
        let registry = state.plugin_registry.lock().await;
        let mcp = state.mcp_manager.lock().await;
        sync_native_plugin_tools(&registry, &mcp.tool_registry);
    }
    let item = {
        let registry = state.plugin_registry.lock().await;
        registry
            .get(&plugin_id)
            .map(|e| PluginListItem {
                id: e.manifest.id.clone(),
                version: e.manifest.version.clone(),
                kind: e.manifest.kind,
                enabled: e.enabled,
                activated: e.activated,
                unsupported_reason: e.unsupported_reason.clone(),
            })
            .ok_or_else(|| OmniError::not_found(format!("未知插件: {plugin_id}")))?
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

/// 第一方插件命令网关。未在编译期登记的 method 一律失败。
#[tauri::command]
#[specta::specta]
pub async fn plugin_invoke(
    state: State<'_, AppState>,
    plugin_id: String,
    method: String,
    args: Value,
) -> Result<Value, OmniError> {
    if plugin_id == PLUGIN_ID_ADDON_EVERYTHING && method == "search" {
        {
            let registry = state.plugin_registry.lock().await;
            registry.require_permission(&plugin_id, PluginPermission::AiTools)?;
            registry.require_permission(&plugin_id, PluginPermission::FsRead)?;
        }
        return run_everything_search(args).await;
    }
    let gateway = state.plugin_invoke.lock().await;
    Ok(gateway.invoke(&plugin_id, &method, args)?)
}

/// 缺权即失败。前端 Host API 在 upsert / 选区 / SSH 探测前必须先过此闸。
#[tauri::command]
#[specta::specta]
pub async fn plugin_require_permission(
    state: State<'_, AppState>,
    plugin_id: String,
    permission: String,
) -> Result<(), OmniError> {
    let perm = PluginPermission::parse(&permission)?;
    let registry = state.plugin_registry.lock().await;
    Ok(registry.require_permission(&plugin_id, perm)?)
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
