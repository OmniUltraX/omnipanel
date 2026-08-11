//! 系统探测：字体枚举、Agent 发现、AI 服务健康检查。

use std::collections::BTreeSet;

use omnipanel_error::OmniError;
use serde::Serialize;

use crate::agents_detect::{detect_all_agents_sync, AgentInstallStatus, AgentKind};

fn collect_system_font_families(monospace_only: bool) -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut families = BTreeSet::new();
    for face in db.faces() {
        if monospace_only && !face.monospaced {
            continue;
        }
        for (family, _) in &face.families {
            let name = family.trim();
            if !name.is_empty() {
                families.insert(name.to_string());
            }
        }
    }
    families.into_iter().collect()
}

pub async fn list_system_fonts(monospace_only: Option<bool>) -> Result<Vec<String>, OmniError> {
    let mono = monospace_only.unwrap_or(false);
    tokio::task::spawn_blocking(move || collect_system_font_families(mono))
        .await
        .map_err(|e| OmniError::internal(format!("字体枚举失败: {e}")))
}

pub async fn detect_all_agents() -> Vec<AgentInstallStatus> {
    detect_all_agents_sync()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeInstallStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

pub async fn detect_opencode_install() -> Result<OpenCodeInstallStatus, OmniError> {
    let agents = detect_all_agents_sync();
    let opencode = agents
        .into_iter()
        .find(|a| a.kind == AgentKind::Opencode)
        .unwrap_or(AgentInstallStatus {
            kind: AgentKind::Opencode,
            installed: false,
            executable_path: None,
            version: None,
            launch_args: Vec::new(),
        });
    Ok(OpenCodeInstallStatus {
        installed: opencode.installed,
        path: opencode.executable_path,
        version: opencode.version,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiServicesHealth {
    pub enabled: bool,
    pub port: u16,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
}

pub async fn ai_services_probe(enabled: bool, port: u16) -> Result<AiServicesHealth, String> {
    if !enabled {
        return Ok(AiServicesHealth {
            enabled: false,
            port,
            reachable: false,
            latency_ms: None,
        });
    }
    let url = format!("http://127.0.0.1:{port}/");
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let reachable = client.get(&url).send().await.is_ok();
    let latency_ms = if reachable {
        Some(start.elapsed().as_millis() as u64)
    } else {
        None
    };
    Ok(AiServicesHealth {
        enabled,
        port,
        reachable,
        latency_ms,
    })
}
