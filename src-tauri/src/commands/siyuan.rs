//! 思源同步源：配置 / 测试连接 / 手动同步 / 状态（只读镜像，写回走内核 API）。

use omnipanel_error::OmniError;
use omnipanel_siyuan::{SiyuanSyncConfig, SiyuanSyncReport};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

/// 测试连接结果（本地：笔记本/文档计数；S3：占位提示）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanTestResult {
    pub ok: bool,
    pub notebooks: i64,
    pub docs: i64,
    pub message: String,
}

/// 同步状态（状态页展示）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSyncStatus {
    pub last_sync_at: i64,
    pub report: Option<SiyuanSyncReport>,
}

/// 读取同步配置（无配置返回默认）。
#[tauri::command]
#[specta::specta]
pub async fn siyuan_config_get(state: State<'_, AppState>) -> Result<SiyuanSyncConfig, OmniError> {
    let storage = state.storage.lock().await;
    storage.siyuan_config_get()
}

/// 保存同步配置（先校验；S3 密钥引用由前端经 Vault 写入）。
#[tauri::command]
#[specta::specta]
pub async fn siyuan_config_save(
    state: State<'_, AppState>,
    config: SiyuanSyncConfig,
) -> Result<(), OmniError> {
    config.validate().map_err(OmniError::invalid_input)?;
    let storage = state.storage.lock().await;
    storage.siyuan_config_save(&config)
}

/// 测试连接：Local 扫描计数；S3 返回占位提示（配置可存，执行后置）。
#[tauri::command]
#[specta::specta]
pub async fn siyuan_test_connection(
    _state: State<'_, AppState>,
    config: SiyuanSyncConfig,
) -> Result<SiyuanTestResult, OmniError> {
    if let Err(message) = config.validate() {
        return Ok(SiyuanTestResult {
            ok: false,
            notebooks: 0,
            docs: 0,
            message,
        });
    }
    match config.source_type {
        omnipanel_store::SiyuanSourceType::S3 => Ok(SiyuanTestResult {
            ok: false,
            notebooks: 0,
            docs: 0,
            message: omnipanel_siyuan::S3_NOT_READY_MSG.to_string(),
        }),
        omnipanel_store::SiyuanSourceType::Local => {
            let path = std::path::PathBuf::from(config.workspace_path.trim());
            match omnipanel_siyuan::test_local_connection(&path) {
                Ok((notebooks, docs)) => Ok(SiyuanTestResult {
                    ok: true,
                    notebooks: notebooks as i64,
                    docs: docs as i64,
                    message: format!("检测到 {notebooks} 个笔记本，共 {docs} 篇文档"),
                }),
                Err(message) => Ok(SiyuanTestResult {
                    ok: false,
                    notebooks: 0,
                    docs: 0,
                    message,
                }),
            }
        }
    }
}

/// 手动同步一次（按已保存配置执行；S3 拒绝并提示）。
#[tauri::command]
#[specta::specta]
pub async fn siyuan_sync_now(state: State<'_, AppState>) -> Result<SiyuanSyncReport, OmniError> {
    let storage = state.storage.lock().await;
    let cfg = storage.siyuan_config_get()?;
    // 与 knowledge_* 命令同模式：持有锁直接执行同步 IO + SQLite。
    omnipanel_siyuan::sync_local(&storage, &cfg)
}

/// 重建同步：清空文件状态后全量重评（删坏重试/状态漂移的显式恢复路径）。
/// 条目 id 稳定可推导，回填覆盖同 id，不产生重复。
#[tauri::command]
#[specta::specta]
pub async fn siyuan_sync_rebuild(
    state: State<'_, AppState>,
) -> Result<SiyuanSyncReport, OmniError> {
    let storage = state.storage.lock().await;
    let cfg = storage.siyuan_config_get()?;
    omnipanel_siyuan::sync_rebuild(&storage, &cfg)
}

/// 同步状态（上次时间 + 上次报告）。
#[tauri::command]
#[specta::specta]
pub async fn siyuan_sync_status(state: State<'_, AppState>) -> Result<SiyuanSyncStatus, OmniError> {
    let storage = state.storage.lock().await;
    let cfg = storage.siyuan_config_get()?;
    let report = if cfg.last_report_json.trim().is_empty() {
        None
    } else {
        serde_json::from_str(&cfg.last_report_json).ok()
    };
    Ok(SiyuanSyncStatus {
        last_sync_at: cfg.last_sync_at,
        report,
    })
}
