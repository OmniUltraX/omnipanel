//! 远端工具能力：Server IPC 薄包装，核心逻辑在 `omnipanel_ssh::capabilities`。

use crate::monitoring::ensure_ssh_session;
use crate::terminal::ServerState;

pub use omnipanel_ssh::capabilities::{
    CapabilityCache, CapabilityProbeResult, EnablePanelApiResult, InstallMethod, InstallToolResult,
    PanelProbeItem, PanelProbeResult, RemoteToolCapability, ToolCategory, ToolSpec, ToolState,
    download_install_binary, enable_panel_api, find_tool_spec, install_remote_tool,
    probe_capabilities, probe_panels,
};

/// 探测远端主机的能力（批量脚本 + 懒探测标记）。
pub async fn ssh_pool_probe_capabilities(
    state: &ServerState,
    resource_id: String,
    force: Option<bool>,
) -> Result<CapabilityProbeResult, omnipanel_error::OmniError> {
    if !force.unwrap_or(false) {
        if let Some(cached) = state.capability_cache.get(&resource_id).await {
            return Ok(cached);
        }
    }

    let (session, _host_name) = ensure_ssh_session(state, &resource_id).await?;
    let result = probe_capabilities(&session, &resource_id).await?;

    state
        .capability_cache
        .set(&resource_id, result.clone())
        .await;

    Ok(result)
}

/// 失效某主机的能力缓存。
pub async fn ssh_pool_invalidate_capabilities(
    state: &ServerState,
    resource_id: String,
) -> Result<(), omnipanel_error::OmniError> {
    state.capability_cache.invalidate(&resource_id).await;
    Ok(())
}

/// 统一安装远端工具。
pub async fn ssh_pool_install_tool(
    state: &ServerState,
    resource_id: String,
    tool_id: String,
) -> Result<InstallToolResult, omnipanel_error::OmniError> {
    let (session, _host_name) = ensure_ssh_session(state, &resource_id).await?;
    let result = install_remote_tool(&session, &tool_id).await?;

    if result.installed {
        state.capability_cache.invalidate(&resource_id).await;
    }

    Ok(result)
}

/// 探测远端主机上已安装的面板（宝塔 / 1Panel）。
pub async fn ssh_pool_probe_panels(
    state: &ServerState,
    resource_id: String,
) -> Result<PanelProbeResult, omnipanel_error::OmniError> {
    let (session, _host_name) = ensure_ssh_session(state, &resource_id).await?;
    probe_panels(&session, &resource_id).await
}

/// 通过 SSH 在远端开启宝塔 / 1Panel 的 API 接口。
pub async fn ssh_pool_enable_panel_api(
    state: &ServerState,
    resource_id: String,
    kind: String,
    allow_all: bool,
) -> Result<EnablePanelApiResult, omnipanel_error::OmniError> {
    let (session, _host_name) = ensure_ssh_session(state, &resource_id).await?;
    enable_panel_api(&session, &kind, allow_all).await
}

/// 供 IPC `ssh_pool_download_install_binary` 与 install_tool 共用。
pub async fn download_install_binary_public(
    state: &ServerState,
    resource_id: &str,
    url: &str,
    remote_path: &str,
) -> Result<String, omnipanel_error::OmniError> {
    let (session, _) = ensure_ssh_session(state, resource_id).await?;
    download_install_binary(&session, url, remote_path).await
}
