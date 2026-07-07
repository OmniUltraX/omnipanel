use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbTreeChartFileNode {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub document: Option<String>,
    #[specta(type = f64)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbTreeChartFilesFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<DbTreeChartFileNode>,
}

fn default_version() -> u32 {
    1
}

fn tree_chart_files_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join("db-tree-chart-files.json"))
}

#[tauri::command]
#[specta::specta]
pub async fn db_tree_chart_files_load(app: AppHandle) -> Result<DbTreeChartFilesFile, String> {
    let path = tree_chart_files_path(&app)?;
    if !path.exists() {
        return Ok(DbTreeChartFilesFile::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("读取 db-tree-chart-files.json 失败 ({}): {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(DbTreeChartFilesFile::default());
    }
    match serde_json::from_str::<DbTreeChartFilesFile>(&raw) {
        Ok(file) => Ok(file),
        Err(e) => {
            eprintln!(
                "[db_tree_chart_files_load] 解析 db-tree-chart-files.json 失败,使用空配置: {e} (path={})",
                path.display()
            );
            Ok(DbTreeChartFilesFile::default())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_tree_chart_files_save(app: AppHandle, file: DbTreeChartFilesFile) -> Result<(), String> {
    let path = tree_chart_files_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换 db-tree-chart-files.json 失败: {e}"))?;
    Ok(())
}
