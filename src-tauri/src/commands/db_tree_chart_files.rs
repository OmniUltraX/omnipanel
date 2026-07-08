use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbTreeChartFileNode {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub document: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
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

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir)
}

fn tree_chart_files_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("db-tree-chart-files.json"))
}

fn tree_chart_files_content_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("tree-chart-files");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 tree-chart-files 目录失败: {e}"))?;
    Ok(dir)
}

fn sanitize_file_stem(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn content_file_path(content_dir: &Path, id: &str) -> PathBuf {
    content_dir.join(format!("{}.ctr", sanitize_file_stem(id)))
}

fn read_document_from_disk(content_dir: &Path, id: &str) -> Option<String> {
    let path = content_file_path(content_dir, id);
    fs::read_to_string(&path).ok().filter(|raw| !raw.trim().is_empty())
}

fn write_document_to_disk(content_dir: &Path, id: &str, document: &str) -> Result<(), String> {
    let path = content_file_path(content_dir, id);
    let tmp = path.with_extension("ctr.tmp");
    fs::write(&tmp, document).map_err(|e| format!("写入 .ctr 文件失败 ({}): {e}", path.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换 .ctr 文件失败 ({}): {e}", path.display()))?;
    Ok(())
}

fn remove_document_from_disk(content_dir: &Path, id: &str) {
    let path = content_file_path(content_dir, id);
    let _ = fs::remove_file(path);
}

fn resolve_node_document(content_dir: &Path, node: &mut DbTreeChartFileNode) {
    if let Some(document) = node.document.as_ref().filter(|raw| !raw.trim().is_empty()) {
        let _ = write_document_to_disk(content_dir, &node.id, document);
        return;
    }
    if let Some(document) = read_document_from_disk(content_dir, &node.id) {
        node.document = Some(document);
    }
}

fn hydrate_nodes_from_content_dir(content_dir: &Path, nodes: &mut [DbTreeChartFileNode]) {
    for node in nodes.iter_mut() {
        resolve_node_document(content_dir, node);
    }
}

fn prune_orphan_content_files(content_dir: &Path, nodes: &[DbTreeChartFileNode]) {
    let entries = match fs::read_dir(content_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("ctr") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let still_exists = nodes.iter().any(|node| sanitize_file_stem(&node.id) == stem);
        if !still_exists {
            remove_document_from_disk(content_dir, &stem);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_tree_chart_files_load(app: AppHandle) -> Result<DbTreeChartFilesFile, String> {
    let index_path = tree_chart_files_index_path(&app)?;
    let content_dir = tree_chart_files_content_dir(&app)?;

    if !index_path.exists() {
        return recover_from_content_dir_only(&content_dir);
    }

    let raw = fs::read_to_string(&index_path)
        .map_err(|e| format!("读取 db-tree-chart-files.json 失败 ({}): {e}", index_path.display()))?;
    if raw.trim().is_empty() {
        return recover_from_content_dir_only(&content_dir);
    }

    let mut file = match serde_json::from_str::<DbTreeChartFilesFile>(&raw) {
        Ok(file) => file,
        Err(e) => {
            eprintln!(
                "[db_tree_chart_files_load] 解析 db-tree-chart-files.json 失败,尝试从 .ctr 目录恢复: {e} (path={})",
                index_path.display()
            );
            return recover_from_content_dir_only(&content_dir);
        }
    };

    hydrate_nodes_from_content_dir(&content_dir, &mut file.nodes);
    Ok(file)
}

fn recover_from_content_dir_only(content_dir: &Path) -> Result<DbTreeChartFilesFile, String> {
    let entries = match fs::read_dir(content_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(DbTreeChartFilesFile::default()),
    };

    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("ctr") {
            continue;
        }
        let document = match fs::read_to_string(&path) {
            Ok(raw) if !raw.trim().is_empty() => raw,
            _ => continue,
        };
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("untitled")
            .to_string();
        let metadata = fs::metadata(&path).ok();
        let updated_at = metadata
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0)
            });
        nodes.push(DbTreeChartFileNode {
            id: stem.clone(),
            name: format!("{stem}.ctr"),
            document: Some(document),
            parent_id: None,
            updated_at,
        });
    }

    nodes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(DbTreeChartFilesFile {
        version: 1,
        nodes,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn db_tree_chart_files_save(app: AppHandle, file: DbTreeChartFilesFile) -> Result<(), String> {
    let index_path = tree_chart_files_index_path(&app)?;
    let content_dir = tree_chart_files_content_dir(&app)?;

    for node in &file.nodes {
        if let Some(document) = node.document.as_ref().filter(|raw| !raw.trim().is_empty()) {
            write_document_to_disk(&content_dir, &node.id, document)?;
        }
    }

    prune_orphan_content_files(&content_dir, &file.nodes);

    let tmp = index_path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时索引失败: {e}"))?;
    fs::rename(&tmp, &index_path)
        .map_err(|e| format!("替换 db-tree-chart-files.json 失败: {e}"))?;
    Ok(())
}
