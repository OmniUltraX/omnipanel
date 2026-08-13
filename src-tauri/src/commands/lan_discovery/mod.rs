//! 局域网 OmniPanel 客户端发现（UDP probe / announce）。

mod engine;
mod protocol;

use omnipanel_error::OmniError;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, State};

use self::engine::LanDiscoveryService;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanDiscoveryPeer {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub version: String,
    pub os: String,
    #[specta(type = f64)]
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanDiscoveryStatus {
    pub responder_ok: bool,
    pub listen_port: Option<u16>,
    pub error: Option<String>,
    pub scanning: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanDiscoveryPeersEvent {
    pub peers: Vec<LanDiscoveryPeer>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanDiscoveryShareOfferEvent {
    pub from_id: String,
    pub from_ip: String,
    pub panel_json: String,
}

/// 应用启动后调用：manage 服务并启动常驻 responder。
pub fn start_responder(app: &AppHandle) {
    let service = LanDiscoveryService::new(app.clone());
    service.spawn_responder();
    app.manage(service);
}

#[tauri::command]
#[specta::specta]
pub async fn lan_discovery_start_scan(
    state: State<'_, LanDiscoveryService>,
) -> Result<(), OmniError> {
    state.start_scan().await
}

#[tauri::command]
#[specta::specta]
pub async fn lan_discovery_stop_scan(
    state: State<'_, LanDiscoveryService>,
) -> Result<(), OmniError> {
    state.stop_scan().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lan_discovery_list_peers(
    state: State<'_, LanDiscoveryService>,
) -> Result<Vec<LanDiscoveryPeer>, OmniError> {
    Ok(state.list_peers().await)
}

#[tauri::command]
#[specta::specta]
pub async fn lan_discovery_status(
    state: State<'_, LanDiscoveryService>,
) -> Result<LanDiscoveryStatus, OmniError> {
    Ok(state.status().await)
}

/// 向指定对端 IP 分享自定义面板 JSON。
#[tauri::command]
#[specta::specta]
pub async fn lan_discovery_share_panel(
    state: State<'_, LanDiscoveryService>,
    peer_ip: String,
    panel_json: String,
) -> Result<(), OmniError> {
    state.share_panel(peer_ip.trim(), &panel_json).await
}
