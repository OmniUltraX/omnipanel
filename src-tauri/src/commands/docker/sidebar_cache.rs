//! Docker 侧栏资源缓存：`~/.omnipd/docker/sidebar-cache.json`。
//! 按连接持久化 containers/images/networks/volumes；前端只保留 UI 态。

use std::collections::HashMap;
use std::path::Path;

use omnipanel_docker::{
    DockerContainerSummary, DockerImageSummary, DockerNetworkSummary, DockerVolumeSummary,
};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_store::docker_sidebar_cache_path;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerSidebarCacheEntry {
    #[serde(default)]
    pub images: Vec<DockerImageSummary>,
    #[serde(default)]
    pub containers: Vec<DockerContainerSummary>,
    #[serde(default)]
    pub networks: Vec<DockerNetworkSummary>,
    #[serde(default)]
    pub volumes: Vec<DockerVolumeSummary>,
    /// 已成功拉取过的分类名：images / containers / networks / volumes
    #[serde(default)]
    pub loaded_categories: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub refreshed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerSidebarCacheSnapshot {
    #[serde(default)]
    pub connections: HashMap<String, DockerSidebarCacheEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerSidebarCacheFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(flatten)]
    snapshot: DockerSidebarCacheSnapshot,
}

fn default_version() -> u32 {
    1
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写 Docker 侧栏缓存失败").with_cause(err.to_string())
}

fn map_json(err: serde_json::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "解析 Docker 侧栏缓存失败").with_cause(err.to_string())
}

pub fn load_docker_sidebar_cache() -> OmniResult<DockerSidebarCacheSnapshot> {
    let path = docker_sidebar_cache_path()?;
    load_docker_sidebar_cache_from(&path)
}

fn load_docker_sidebar_cache_from(path: &Path) -> OmniResult<DockerSidebarCacheSnapshot> {
    if !path.is_file() {
        return Ok(DockerSidebarCacheSnapshot::default());
    }
    let content = std::fs::read_to_string(path).map_err(map_io)?;
    if content.trim().is_empty() {
        return Ok(DockerSidebarCacheSnapshot::default());
    }
    let file: DockerSidebarCacheFile = serde_json::from_str(&content).map_err(map_json)?;
    Ok(file.snapshot)
}

fn save_docker_sidebar_cache_to(
    path: &Path,
    snapshot: &DockerSidebarCacheSnapshot,
) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    let file = DockerSidebarCacheFile {
        version: 1,
        snapshot: snapshot.clone(),
    };
    let json = serde_json::to_string(&file).map_err(map_json)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

pub fn patch_docker_sidebar_cache_connection(
    connection_id: &str,
    entry: DockerSidebarCacheEntry,
) -> OmniResult<()> {
    let path = docker_sidebar_cache_path()?;
    let mut snapshot = load_docker_sidebar_cache_from(&path)?;
    snapshot
        .connections
        .insert(connection_id.to_string(), entry);
    save_docker_sidebar_cache_to(&path, &snapshot)
}

pub fn remove_docker_sidebar_cache_connection(connection_id: &str) -> OmniResult<()> {
    let path = docker_sidebar_cache_path()?;
    let mut snapshot = load_docker_sidebar_cache_from(&path)?;
    if snapshot.connections.remove(connection_id).is_none() {
        return Ok(());
    }
    save_docker_sidebar_cache_to(&path, &snapshot)
}

/// 分页列表结果（按分类只填对应字段）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerSidebarCachePage {
    pub category: String,
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
    #[serde(default)]
    pub images: Vec<DockerImageSummary>,
    #[serde(default)]
    pub containers: Vec<DockerContainerSummary>,
    #[serde(default)]
    pub networks: Vec<DockerNetworkSummary>,
    #[serde(default)]
    pub volumes: Vec<DockerVolumeSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub refreshed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn page_slice<T: Clone>(items: &[T], offset: usize, limit: usize) -> (u32, Vec<T>) {
    let total = items.len() as u32;
    if limit == 0 || offset >= items.len() {
        return (total, Vec::new());
    }
    let end = (offset + limit).min(items.len());
    (total, items[offset..end].to_vec())
}

pub fn list_docker_sidebar_cache_page(
    connection_id: &str,
    category: &str,
    offset: u32,
    limit: u32,
) -> OmniResult<DockerSidebarCachePage> {
    let snapshot = load_docker_sidebar_cache()?;
    let entry = snapshot
        .connections
        .get(connection_id)
        .cloned()
        .unwrap_or_default();
    let offset_usize = offset as usize;
    let limit_usize = if limit == 0 { 200 } else { limit as usize };

    let mut page = DockerSidebarCachePage {
        category: category.to_string(),
        total: 0,
        offset,
        limit: limit_usize as u32,
        images: Vec::new(),
        containers: Vec::new(),
        networks: Vec::new(),
        volumes: Vec::new(),
        refreshed_at: entry.refreshed_at,
        error: entry.error.clone(),
    };

    match category {
        "images" => {
            let (total, items) = page_slice(&entry.images, offset_usize, limit_usize);
            page.total = total;
            page.images = items;
        }
        "containers" => {
            let (total, items) = page_slice(&entry.containers, offset_usize, limit_usize);
            page.total = total;
            page.containers = items;
        }
        "networks" => {
            let (total, items) = page_slice(&entry.networks, offset_usize, limit_usize);
            page.total = total;
            page.networks = items;
        }
        "volumes" => {
            let (total, items) = page_slice(&entry.volumes, offset_usize, limit_usize);
            page.total = total;
            page.volumes = items;
        }
        other => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知侧栏缓存分类: {other}"),
            ));
        }
    }
    Ok(page)
}

#[tauri::command]
#[specta::specta]
pub async fn docker_load_sidebar_cache() -> Result<DockerSidebarCacheSnapshot, OmniError> {
    load_docker_sidebar_cache()
}

#[tauri::command]
#[specta::specta]
pub async fn docker_patch_sidebar_cache(
    connection_id: String,
    entry: DockerSidebarCacheEntry,
) -> Result<(), OmniError> {
    patch_docker_sidebar_cache_connection(&connection_id, entry)
}

#[tauri::command]
#[specta::specta]
pub async fn docker_remove_sidebar_cache(connection_id: String) -> Result<(), OmniError> {
    remove_docker_sidebar_cache_connection(&connection_id)
}

#[tauri::command]
#[specta::specta]
pub async fn docker_list_sidebar_cache_page(
    connection_id: String,
    category: String,
    offset: u32,
    limit: u32,
) -> Result<DockerSidebarCachePage, OmniError> {
    list_docker_sidebar_cache_page(&connection_id, &category, offset, limit)
}
