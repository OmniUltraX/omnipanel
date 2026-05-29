use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize, specta::Type)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub body: String,
}

#[tauri::command]
#[specta::specta]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: update.version.clone(),
            body: update.body.clone().unwrap_or_default(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: String::new(),
            body: String::new(),
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart()
        }
        Ok(None) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
