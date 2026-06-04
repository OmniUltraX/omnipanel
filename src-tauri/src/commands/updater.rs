use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub body: String,
    pub current_version: String,
}

#[tauri::command]
#[specta::specta]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.config().version.clone().unwrap_or_default();
    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: update.version.clone(),
            body: update.body.clone().unwrap_or_default(),
            current_version: update.current_version.clone(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: current_version.clone(),
            body: String::new(),
            current_version,
        }),
        Err(e) => {
            tracing::warn!("Update check failed: {e}");
            Ok(UpdateInfo {
                available: false,
                version: current_version.clone(),
                body: String::new(),
                current_version,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct UpdateProgress {
    chunk_length: u64,
    content_length: Option<u64>,
}

#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            let _ = app.emit(
                "update-download-progress",
                UpdateProgress {
                    chunk_length: 0,
                    content_length: None,
                },
            );

            update
                .download_and_install(
                    |chunk_length, content_length| {
                        let _ = app.emit(
                            "update-download-progress",
                            UpdateProgress {
                                chunk_length: chunk_length as u64,
                                content_length,
                            },
                        );
                    },
                    || {
                        let _ = app.emit("update-download-complete", ());
                    },
                )
                .await
                .map_err(|e| e.to_string())?;

            app.restart()
        }
        Ok(None) => Err("No update available".to_string()),
        Err(e) => Err(e.to_string()),
    }
}
