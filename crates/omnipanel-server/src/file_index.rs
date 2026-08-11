//! 文件模块 FTS5 索引（Web 端）：递归扫描本地文件并写入 SQLite。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    default_file_index_storage_dir, FileIndexBatchItem, FileIndexProgress, FileIndexSearchResult,
    FileIndexStatus, FileIndexStorage,
};
use serde::{Deserialize, Serialize};

use crate::files::{local_home, resolve_local_path, LOCAL_CONNECTION_ID};
use crate::state::ServerState;

const MAX_INDEX_ENTRIES: usize = 200_000;
const INDEX_BATCH_SIZE: usize = 400;
const MAX_CONTENT_BYTES: u64 = 64 * 1024;

static TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "js", "ts", "tsx",
    "jsx", "css", "html", "rs", "go", "py", "sh", "sql", "log",
];

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_text_file(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    TEXT_EXTENSIONS.contains(&ext.as_str())
}

fn read_local_content(path: &str, size: u64) -> String {
    if size == 0 || size > MAX_CONTENT_BYTES || !is_text_file(path) {
        return String::new();
    }
    crate::files::file_read_file_sync_local(path, MAX_CONTENT_BYTES)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

/// 文件索引存储目录信息（与桌面端 `FileIndexStorageInfo` 同形）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexStorageInfo {
    pub storage_dir: String,
    pub database_path: String,
    pub default_dir: String,
    pub is_custom: bool,
}

fn build_storage_info(
    configured_dir: &str,
    storage: &FileIndexStorage,
) -> Result<FileIndexStorageInfo, OmniError> {
    let default_dir = default_file_index_storage_dir()
        .map_err(|e| OmniError::new(ErrorCode::Storage, "无法解析默认索引目录").with_cause(e.to_string()))?
        .to_string_lossy()
        .into_owned();
    let database_path = storage.database_path().to_string_lossy().into_owned();
    let storage_dir = storage
        .database_path()
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(FileIndexStorageInfo {
        storage_dir,
        database_path,
        default_dir,
        is_custom: !configured_dir.trim().is_empty(),
    })
}

fn cancel_all_file_index_tasks(state: &ServerState) {
    if let Ok(mut tasks) = state.file_index_tasks.try_lock() {
        for (_, cancel) in tasks.drain() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

struct IndexWalkContext<'a> {
    state: &'a ServerState,
    connection_id: &'a str,
    cancel: Arc<AtomicBool>,
}

async fn flush_batch(
    ctx: &IndexWalkContext<'_>,
    batch: &mut Vec<FileIndexBatchItem>,
    indexed: usize,
) -> Result<(), OmniError> {
    if batch.is_empty() {
        return Ok(());
    }
    {
        let storage = ctx.state.file_index_storage.lock().await;
        storage.insert_file_index_batch(ctx.connection_id, batch)?;
        storage.update_file_index_progress(ctx.connection_id, indexed as i64)?;
    }
    let payload = FileIndexProgress {
        connection_id: ctx.connection_id.to_string(),
        status: "building".into(),
        indexed_count: indexed as i64,
        error: String::new(),
    };
    ctx.state.bus.emit(
        "file-index-progress",
        serde_json::to_value(&payload).unwrap_or_default(),
    );
    batch.clear();
    Ok(())
}

fn emit_index_done(state: &ServerState, connection_id: &str, indexed: i64, error: Option<String>) {
    let payload = FileIndexProgress {
        connection_id: connection_id.to_string(),
        status: if error.is_some() {
            "failed".into()
        } else {
            "done".into()
        },
        indexed_count: indexed,
        error: error.unwrap_or_default(),
    };
    state.bus.emit(
        "file-index-progress",
        serde_json::to_value(&payload).unwrap_or_default(),
    );
}

async fn collect_local_dir(
    ctx: &IndexWalkContext<'_>,
    batch: &mut Vec<FileIndexBatchItem>,
    indexed: &mut usize,
) -> Result<(), OmniError> {
    let root_path = resolve_local_path(&local_home()?.to_string_lossy())?;
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    queue.push_back(root_path);

    while let Some(dir) = queue.pop_front() {
        if ctx.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        if *indexed >= MAX_INDEX_ENTRIES {
            break;
        }
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in read_dir.flatten() {
            if ctx.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            if *indexed >= MAX_INDEX_ENTRIES {
                break;
            }
            let path = entry.path();
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let name = entry.file_name().to_string_lossy().to_string();
            let full = path.to_string_lossy().to_string();
            let size = meta
                .as_ref()
                .map(|m| if m.is_dir() { 0 } else { m.len() })
                .unwrap_or(0);
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let content = if is_dir {
                String::new()
            } else {
                read_local_content(&full, size)
            };
            batch.push(FileIndexBatchItem {
                path: full.clone(),
                name,
                kind: if is_dir { "dir".into() } else { "file".into() },
                size,
                modified,
                content,
            });
            *indexed += 1;
            if batch.len() >= INDEX_BATCH_SIZE {
                flush_batch(ctx, batch, *indexed).await?;
            }
            if is_dir {
                queue.push_back(path);
            }
        }
    }
    Ok(())
}

async fn run_file_index_build(
    state: Arc<ServerState>,
    connection_id: String,
    cancel: Arc<AtomicBool>,
) {
    let started_at = now_secs();
    let mut indexed = 0usize;
    let mut batch: Vec<FileIndexBatchItem> = Vec::with_capacity(INDEX_BATCH_SIZE);
    let root_path = local_home()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut build_error: Option<String> = None;

    {
        let storage = state.file_index_storage.lock().await;
        if let Err(e) = storage.begin_file_index(&connection_id, &root_path, started_at) {
            build_error = Some(e.to_string());
        }
    }

    if build_error.is_none() {
        let ctx = IndexWalkContext {
            state: &state,
            connection_id: &connection_id,
            cancel: cancel.clone(),
        };
        if let Err(e) = collect_local_dir(&ctx, &mut batch, &mut indexed).await {
            build_error = Some(e.to_string());
        }
        if !batch.is_empty() && build_error.is_none() {
            if let Err(e) = flush_batch(&ctx, &mut batch, indexed).await {
                build_error = Some(e.to_string());
            }
        }
    }

    let finished_at = now_secs();
    {
        let storage = state.file_index_storage.lock().await;
        let _ = storage.finish_file_index(
            &connection_id,
            indexed as i64,
            finished_at,
            build_error.as_deref(),
        );
    }

    emit_index_done(&state, &connection_id, indexed as i64, build_error);

    if let Ok(mut tasks) = state.file_index_tasks.try_lock() {
        tasks.remove(&connection_id);
    }
}

pub async fn file_index_build(
    state: Arc<ServerState>,
    connection_id: String,
) -> Result<FileIndexStatus, String> {
    if connection_id != LOCAL_CONNECTION_ID {
        return Err("仅本地文件支持索引构建，远程文件请使用协议原生搜索".to_string());
    }

    {
        let storage = state.file_index_storage.lock().await;
        let status = storage
            .get_file_index_status(&connection_id)
            .map_err(|e| e.to_string())?;
        if status.status == "building" {
            return Ok(status);
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut tasks = state
            .file_index_tasks
            .lock()
            .map_err(|_| "索引任务锁失败".to_string())?;
        tasks.insert(connection_id.clone(), cancel.clone());
    }

    let conn_id = connection_id.clone();
    let state_spawn = state.clone();
    tokio::spawn(async move {
        run_file_index_build(state_spawn, conn_id, cancel).await;
    });

    let storage = state.file_index_storage.lock().await;
    storage
        .get_file_index_status(&connection_id)
        .map_err(|e| e.to_string())
}

pub async fn file_index_search(
    state: &ServerState,
    connection_id: String,
    query: String,
    limit: Option<f64>,
) -> Result<Vec<FileIndexSearchResult>, String> {
    let storage = state.file_index_storage.lock().await;
    let limit = limit.unwrap_or(100.0) as i64;
    storage
        .search_file_index(&connection_id, &query, limit)
        .map_err(|e| e.to_string())
}

pub async fn file_index_status(
    state: &ServerState,
    connection_id: String,
) -> Result<FileIndexStatus, String> {
    let storage = state.file_index_storage.lock().await;
    storage
        .get_file_index_status(&connection_id)
        .map_err(|e| e.to_string())
}

pub async fn file_index_clear(
    state: &ServerState,
    connection_id: String,
) -> Result<(), String> {
    if let Ok(mut tasks) = state.file_index_tasks.try_lock() {
        if let Some(cancel) = tasks.remove(&connection_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    let storage = state.file_index_storage.lock().await;
    storage
        .clear_file_index(&connection_id)
        .map_err(|e| e.to_string())
}

pub async fn file_index_cancel(
    state: &ServerState,
    connection_id: String,
) -> Result<(), String> {
    if let Ok(tasks) = state.file_index_tasks.try_lock() {
        if let Some(cancel) = tasks.get(&connection_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

pub async fn file_index_storage_info(state: &ServerState) -> Result<FileIndexStorageInfo, String> {
    let configured = state.file_index_storage_dir.lock().await.clone();
    let storage = state.file_index_storage.lock().await;
    build_storage_info(&configured, &storage).map_err(|e| e.to_string())
}

pub async fn set_file_index_storage_dir(
    state: &ServerState,
    dir: String,
) -> Result<FileIndexStorageInfo, String> {
    let normalized = dir.trim().to_string();
    {
        let current = state.file_index_storage_dir.lock().await.clone();
        if current == normalized {
            let storage = state.file_index_storage.lock().await;
            return build_storage_info(&normalized, &storage).map_err(|e| e.to_string());
        }
    }

    cancel_all_file_index_tasks(state);

    let new_storage = FileIndexStorage::open_at_dir(&normalized)
        .map_err(|e| format!("无法打开文件索引存储: {e}"))?;

    {
        let mut guard = state.file_index_storage.lock().await;
        *guard = new_storage;
    }
    {
        let mut dir_guard = state.file_index_storage_dir.lock().await;
        *dir_guard = normalized.clone();
    }

    let storage = state.file_index_storage.lock().await;
    build_storage_info(&normalized, &storage).map_err(|e| e.to_string())
}

/// 初始化文件索引存储（`ServerState::new` 调用）。
pub fn open_file_index_storage(
    meta_storage: &omnipanel_store::Storage,
) -> Result<Arc<tokio::sync::Mutex<FileIndexStorage>>, String> {
    let _ = FileIndexStorage::import_from_meta_storage_if_empty(meta_storage)
        .map_err(|e| e.to_string())?;
    let storage = FileIndexStorage::open_at_dir("")
        .map_err(|e| format!("打开文件索引存储失败: {e}"))?;
    Ok(Arc::new(tokio::sync::Mutex::new(storage)))
}
