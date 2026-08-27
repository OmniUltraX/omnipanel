//! 远端工具能力：Tauri 命令薄包装，核心逻辑在 `omnipanel_ssh::capabilities`。

use tauri::State;

use omnipanel_ssh::capabilities::{
    CapabilityProbeResult, EnablePanelApiResult, InstallToolResult, PanelProbeResult,
    enable_panel_api, install_remote_tool, probe_capabilities, probe_panels,
};

use crate::state::AppState;

use super::ssh::pool_session;

pub use omnipanel_ssh::capabilities::CapabilityCache;

/// 探测远端主机的能力（批量脚本 + 懒探测标记）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_probe_capabilities(
    state: State<'_, AppState>,
    resource_id: String,
    force: Option<bool>,
) -> Result<CapabilityProbeResult, omnipanel_error::OmniError> {
    if !force.unwrap_or(false) {
        if let Some(cached) = state.capability_cache.get(&resource_id).await {
            return Ok(cached);
        }
    }

    let session = pool_session(&state, &resource_id).await?;
    let result = probe_capabilities(&session, &resource_id).await?;

    state
        .capability_cache
        .set(&resource_id, result.clone())
        .await;

    Ok(result)
}

/// 失效某主机的能力缓存（安装后或手动触发时调用）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_invalidate_capabilities(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<(), omnipanel_error::OmniError> {
    state.capability_cache.invalidate(&resource_id).await;
    // 联动清除 tmux unsupported 缓存：用户刷新能力探测通常是因为装/升了 tmux，
    // 不清则本进程内新 Tab 仍会因旧标记降级直连。
    state.tmux.invalidate_all().await;
    Ok(())
}

/// 统一安装远端工具。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_install_tool(
    state: State<'_, AppState>,
    resource_id: String,
    tool_id: String,
) -> Result<InstallToolResult, omnipanel_error::OmniError> {
    let session = pool_session(&state, &resource_id).await?;
    let result = install_remote_tool(&session, &tool_id).await?;

    if result.installed {
        state.capability_cache.invalidate(&resource_id).await;
        if tool_id == "tmux" {
            state.tmux.invalidate_all().await;
        }
    }

    Ok(result)
}

/// 探测远端主机上已安装的面板（宝塔 / 1Panel）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_probe_panels(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<PanelProbeResult, omnipanel_error::OmniError> {
    let session = pool_session(&state, &resource_id).await?;
    probe_panels(&session, &resource_id).await
}

/// 通过 SSH 在远端开启宝塔 / 1Panel 的 API 接口。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_enable_panel_api(
    state: State<'_, AppState>,
    resource_id: String,
    kind: String,
    allow_all: bool,
) -> Result<EnablePanelApiResult, omnipanel_error::OmniError> {
    let session = pool_session(&state, &resource_id).await?;
    enable_panel_api(&session, &kind, allow_all).await
}
