//! 文件模块 FTS5 索引：递归扫描本地 / SFTP / FTP / S3 并写入 SQLite。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{Connection, FileIndexBatchItem, FileIndexProgress, FileIndexSearchResult, FileIndexStatus, FileIndexStorage, default_file_index_storage_dir};
use s3::bucket::Bucket;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

use super::file_manager::{
    ftp_connect_sync, list_ftp_dir, local_home, local_read, mark_file_connection_online,
    normalize_s3_prefix, parse_file_config, protocol_of, resolve_local_path, resolve_secret,
    s3_bucket, sftp_entry_to_file, sftp_session_for, FileConnConfig, FileEntry, FileProtocol,
    LOCAL_CONNECTION_ID,
};

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

fn entry_to_batch(entry: &FileEntry, content: String) -> FileIndexBatchItem {
    FileIndexBatchItem {
        path: entry.path.clone(),
        name: entry.name.clone(),
        kind: entry.kind.clone(),
        size: entry.size,
        modified: entry.modified,
        content,
    }
}

fn read_local_content(path: &str, size: u64) -> String {
    if size == 0 || size > MAX_CONTENT_BYTES || !is_text_file(path) {
        return String::new();
    }
    local_read(path, MAX_CONTENT_BYTES)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

async fn read_remote_content(
    state: &AppState,
    connection_id: &str,
    conn: &Connection,
    cfg: &FileConnConfig,
    path: &str,
    size: u64,
) -> String {
    if size == 0 || size > MAX_CONTENT_BYTES || !is_text_file(path) {
        return String::new();
    }
    match protocol_of(cfg) {
        FileProtocol::Sftp => {
            let Ok(session) = sftp_session_for(state, connection_id, conn, cfg).await else {
                return String::new();
            };
            let Ok(data) = session.sftp_download(path).await else {
                return String::new();
            };
            if data.len() as u64 > MAX_CONTENT_BYTES {
                return String::new();
            }
            String::from_utf8(data).unwrap_or_default()
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = resolve_secret(conn).unwrap_or_default();
            let path = path.to_string();
            match tokio::task::spawn_blocking(move || {
                use std::io::Read;
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                let reader = ftp.retr_as_stream(&path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 读取失败").with_cause(e.to_string())
                })?;
                let mut buf = Vec::new();
                reader
                    .take(MAX_CONTENT_BYTES + 1)
                    .read_to_end(&mut buf)
                    .map_err(|e| OmniError::new(ErrorCode::Io, "FTP 读取失败").with_cause(e.to_string()))?;
                let _ = ftp.quit();
                if buf.len() as u64 > MAX_CONTENT_BYTES {
                    return Ok::<String, OmniError>(String::new());
                }
                Ok(String::from_utf8(buf).unwrap_or_default())
            })
            .await
            {
                Ok(Ok(text)) => text,
                _ => String::new(),
            }
        }
        FileProtocol::S3 => {
            let secret = resolve_secret(conn).unwrap_or_default();
            let Ok(bucket) = s3_bucket(cfg, &secret) else {
                return String::new();
            };
            let Ok(response) = bucket.get_object(path).await else {
                return String::new();
            };
            let bytes = response.bytes();
            if bytes.len() as u64 > MAX_CONTENT_BYTES {
                return String::new();
            }
            String::from_utf8(bytes.to_vec()).unwrap_or_default()
        }
        FileProtocol::Local => read_local_content(path, size),
    }
}

async fn resolve_index_root(
    connection_id: &str,
    _conn: Option<&Connection>,
    cfg: Option<&FileConnConfig>,
) -> Result<String, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(local_home()?.to_string_lossy().into_owned());
    }
    let cfg = cfg.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    if !cfg.root_path.is_empty() {
        return Ok(cfg.root_path.clone());
    }
    match protocol_of(cfg) {
        FileProtocol::S3 => Ok(normalize_s3_prefix("", cfg)),
        FileProtocol::Local => Ok(String::new()),
        FileProtocol::Sftp | FileProtocol::Ftp => Ok("/".to_string()),
    }
}

struct IndexWalkContext<'a> {
    state: &'a AppState,
    connection_id: &'a str,
    conn: Option<&'a Connection>,
    cfg: Option<&'a FileConnConfig>,
    secret: &'a str,
    cancel: Arc<AtomicBool>,
}

async fn collect_local_dir(
    ctx: &IndexWalkContext<'_>,
    batch: &mut Vec<FileIndexBatchItem>,
    indexed: &mut usize,
) -> Result<(), OmniError> {
    let root = resolve_index_root(ctx.connection_id, ctx.conn, ctx.cfg).await?;
    let root_path = resolve_local_path(&root)?;
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

async fn collect_sftp_dir(
    ctx: &IndexWalkContext<'_>,
    batch: &mut Vec<FileIndexBatchItem>,
    indexed: &mut usize,
) -> Result<(), OmniError> {
    let conn = ctx.conn.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = ctx.cfg.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let root = resolve_index_root(ctx.connection_id, Some(conn), Some(cfg)).await?;
    let session = sftp_session_for(ctx.state, ctx.connection_id, conn, cfg).await?;
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(root);

    while let Some(dir) = queue.pop_front() {
        if ctx.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        if *indexed >= MAX_INDEX_ENTRIES {
            break;
        }
        let list = session.sftp_list(&dir).await?;
        for entry in list {
            if ctx.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            if *indexed >= MAX_INDEX_ENTRIES {
                break;
            }
            let file_entry = sftp_entry_to_file(&entry, &dir);
            let content = if file_entry.kind == "file" {
                read_remote_content(
                    ctx.state,
                    ctx.connection_id,
                    conn,
                    cfg,
                    &file_entry.path,
                    file_entry.size,
                )
                .await
            } else {
                String::new()
            };
            batch.push(entry_to_batch(&file_entry, content));
            *indexed += 1;
            if batch.len() >= INDEX_BATCH_SIZE {
                flush_batch(ctx, batch, *indexed).await?;
            }
            if file_entry.kind == "dir" {
                queue.push_back(file_entry.path);
            }
        }
    }
    Ok(())
}

async fn collect_ftp_dir(
    ctx: &IndexWalkContext<'_>,
    batch: &mut Vec<FileIndexBatchItem>,
    indexed: &mut usize,
) -> Result<(), OmniError> {
    let conn = ctx.conn.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = ctx.cfg.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let root = resolve_index_root(ctx.connection_id, Some(conn), Some(cfg)).await?;
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(root);

    while let Some(dir) = queue.pop_front() {
        if ctx.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        if *indexed >= MAX_INDEX_ENTRIES {
            break;
        }
        let entries = list_ftp_dir(cfg, ctx.secret, &dir).await?;
        for file_entry in entries {
            if ctx.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            if *indexed >= MAX_INDEX_ENTRIES {
                break;
            }
            let content = if file_entry.kind == "file" {
                read_remote_content(
                    ctx.state,
                    ctx.connection_id,
                    conn,
                    cfg,
                    &file_entry.path,
                    file_entry.size,
                )
                .await
            } else {
                String::new()
            };
            batch.push(entry_to_batch(&file_entry, content));
            *indexed += 1;
            if batch.len() >= INDEX_BATCH_SIZE {
                flush_batch(ctx, batch, *indexed).await?;
            }
            if file_entry.kind == "dir" {
                queue.push_back(file_entry.path);
            }
        }
    }
    Ok(())
}

async fn collect_s3_objects(
    ctx: &IndexWalkContext<'_>,
    batch: &mut Vec<FileIndexBatchItem>,
    indexed: &mut usize,
) -> Result<(), OmniError> {
    let conn = ctx.conn.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = ctx.cfg.ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let prefix = resolve_index_root(ctx.connection_id, Some(conn), Some(cfg)).await?;
    let bucket: Box<Bucket> = s3_bucket(cfg, ctx.secret)?;
    let mut token: Option<String> = None;

    loop {
        if ctx.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        if *indexed >= MAX_INDEX_ENTRIES {
            break;
        }
        let (page, _status) = bucket
            .list_page(prefix.clone(), None, token.clone(), None, Some(1000))
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "列出 S3 对象失败").with_cause(e.to_string())
            })?;

        if let Some(prefixes) = page.common_prefixes {
            for cp in prefixes {
                if *indexed >= MAX_INDEX_ENTRIES {
                    break;
                }
                let key = cp.prefix.trim_end_matches('/');
                let name = key.rsplit('/').next().unwrap_or(&key).to_string();
                batch.push(FileIndexBatchItem {
                    path: cp.prefix.clone(),
                    name,
                    kind: "dir".into(),
                    size: 0,
                    modified: 0,
                    content: String::new(),
                });
                *indexed += 1;
                if batch.len() >= INDEX_BATCH_SIZE {
                    flush_batch(ctx, batch, *indexed).await?;
                }
            }
        }

        for obj in page.contents {
            if obj.key.ends_with('/') {
                continue;
            }
            if *indexed >= MAX_INDEX_ENTRIES {
                break;
            }
            let name = obj
                .key
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&obj.key)
                .to_string();
            let content = read_remote_content(
                ctx.state,
                ctx.connection_id,
                conn,
                cfg,
                &obj.key,
                obj.size,
            )
            .await;
            batch.push(FileIndexBatchItem {
                path: obj.key.clone(),
                name,
                kind: "file".into(),
                size: obj.size,
                modified: 0,
                content,
            });
            *indexed += 1;
            if batch.len() >= INDEX_BATCH_SIZE {
                flush_batch(ctx, batch, *indexed).await?;
            }
        }

        if !page.is_truncated {
            break;
        }
        token = page.next_continuation_token;
        if token.is_none() {
            break;
        }
    }
    Ok(())
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
    let _ = ctx.state.app_handle.emit("file-index-progress", &payload);
    batch.clear();
    Ok(())
}

fn emit_index_done(state: &AppState, connection_id: &str, indexed: i64, error: Option<String>) {
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
    let _ = state.app_handle.emit("file-index-progress", &payload);
}

async fn run_file_index_build(app: AppHandle, connection_id: String, cancel: Arc<AtomicBool>) {
    let state = app.state::<AppState>();
    let started_at = now_secs();
    let mut indexed = 0usize;
    let mut batch: Vec<FileIndexBatchItem> = Vec::with_capacity(INDEX_BATCH_SIZE);
    let mut root_path = String::new();
    let mut build_error: Option<String> = None;

    let conn_opt = if connection_id == LOCAL_CONNECTION_ID {
        None
    } else {
        match super::file_manager::load_file_connection(state.inner(), &connection_id).await {
            Ok(Some(c)) => Some(c),
            Ok(None) => {
                build_error = Some("连接不存在".into());
                None
            }
            Err(e) => {
                build_error = Some(e.to_string());
                None
            }
        }
    };

    let cfg_opt = conn_opt.as_ref().map(|c| parse_file_config(c)).transpose();
    let cfg_owned;
    let cfg_ref = match cfg_opt {
        Ok(Some(cfg)) => {
            cfg_owned = cfg;
            Some(&cfg_owned)
        }
        Ok(None) => None,
        Err(e) => {
            build_error = Some(e.to_string());
            None
        }
    };

    if build_error.is_none() {
        root_path = match resolve_index_root(&connection_id, conn_opt.as_ref(), cfg_ref).await {
            Ok(p) => p,
            Err(e) => {
                build_error = Some(e.to_string());
                String::new()
            }
        };
    }

    if build_error.is_none() {
        {
            let storage = state.file_index_storage.lock().await;
            if let Err(e) = storage.begin_file_index(&connection_id, &root_path, started_at) {
                build_error = Some(e.to_string());
            }
        }
    }

    let secret = conn_opt
        .as_ref()
        .and_then(|c| resolve_secret(c))
        .unwrap_or_default();

    if build_error.is_none() {
        let ctx = IndexWalkContext {
            state: state.inner(),
            connection_id: &connection_id,
            conn: conn_opt.as_ref(),
            cfg: cfg_ref,
            secret: &secret,
            cancel: cancel.clone(),
        };
        let walk_result = if connection_id == LOCAL_CONNECTION_ID {
            collect_local_dir(&ctx, &mut batch, &mut indexed).await
        } else if let Some(cfg) = cfg_ref {
            match protocol_of(cfg) {
                FileProtocol::Local => collect_local_dir(&ctx, &mut batch, &mut indexed).await,
                FileProtocol::Sftp => collect_sftp_dir(&ctx, &mut batch, &mut indexed).await,
                FileProtocol::Ftp => collect_ftp_dir(&ctx, &mut batch, &mut indexed).await,
                FileProtocol::S3 => collect_s3_objects(&ctx, &mut batch, &mut indexed).await,
            }
        } else {
            Err(OmniError::new(ErrorCode::NotFound, "连接不存在"))
        };

        if let Err(e) = walk_result {
            build_error = Some(e.to_string());
        }
        if !batch.is_empty() && build_error.is_none() {
            if let Err(e) = flush_batch(&ctx, &mut batch, indexed).await {
                build_error = Some(e.to_string());
            }
        }
        mark_file_connection_online(state.inner(), &connection_id);
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

    emit_index_done(state.inner(), &connection_id, indexed as i64, build_error);

    if let Ok(mut tasks) = state.file_index_tasks.lock() {
        tasks.remove(&connection_id);
    }
}

/// 启动后台文件索引构建（本地与远程连接均支持）。
#[tauri::command]
#[specta::specta]
pub async fn file_index_build(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<FileIndexStatus, OmniError> {
    {
        let storage = state.file_index_storage.lock().await;
        let status = storage.get_file_index_status(&connection_id)?;
        if status.status == "building" {
            return Ok(status);
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut tasks = state
            .file_index_tasks
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "索引任务锁失败"))?;
        tasks.insert(connection_id.clone(), cancel.clone());
    }

    let app = state.app_handle.clone();
    let conn_id = connection_id.clone();
    tokio::spawn(async move {
        run_file_index_build(app, conn_id, cancel).await;
    });

    let storage = state.file_index_storage.lock().await;
    storage.get_file_index_status(&connection_id)
}

/// FTS5 搜索已索引文件。
#[tauri::command]
#[specta::specta]
pub async fn file_index_search(
    state: State<'_, AppState>,
    connection_id: String,
    query: String,
    limit: Option<f64>,
) -> Result<Vec<FileIndexSearchResult>, OmniError> {
    let storage = state.file_index_storage.lock().await;
    let limit = limit.unwrap_or(100.0) as i64;
    storage.search_file_index(&connection_id, &query, limit)
}

/// 获取连接的文件索引状态。
#[tauri::command]
#[specta::specta]
pub async fn file_index_status(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<FileIndexStatus, OmniError> {
    let storage = state.file_index_storage.lock().await;
    storage.get_file_index_status(&connection_id)
}

/// 清除连接的文件索引。
#[tauri::command]
#[specta::specta]
pub async fn file_index_clear(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), OmniError> {
    if let Ok(mut tasks) = state.file_index_tasks.lock() {
        if let Some(cancel) = tasks.remove(&connection_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    let storage = state.file_index_storage.lock().await;
    storage.clear_file_index(&connection_id)
}

/// 取消正在进行的索引构建。
#[tauri::command]
#[specta::specta]
pub async fn file_index_cancel(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), OmniError> {
    if let Ok(tasks) = state.file_index_tasks.lock() {
        if let Some(cancel) = tasks.get(&connection_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// 文件索引存储目录信息。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexStorageInfo {
    /// 当前生效的索引目录（数据库文件所在目录）。
    pub storage_dir: String,
    /// 索引 SQLite 文件完整路径。
    pub database_path: String,
    /// 默认索引目录。
    pub default_dir: String,
    /// 是否为用户自定义目录。
    pub is_custom: bool,
}

fn build_storage_info(configured_dir: &str, storage: &FileIndexStorage) -> Result<FileIndexStorageInfo, OmniError> {
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

fn cancel_all_file_index_tasks(state: &AppState) {
    if let Ok(mut tasks) = state.file_index_tasks.lock() {
        for (_, cancel) in tasks.drain() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// 获取当前文件索引存储目录信息。
#[tauri::command]
#[specta::specta]
pub async fn file_index_storage_info(
    state: State<'_, AppState>,
) -> Result<FileIndexStorageInfo, OmniError> {
    let configured = state.file_index_storage_dir.lock().await.clone();
    let storage = state.file_index_storage.lock().await;
    build_storage_info(&configured, &storage)
}

/// 设置文件索引存储目录（空字符串表示恢复默认）。切换目录后需重新构建索引。
#[tauri::command]
#[specta::specta]
pub async fn set_file_index_storage_dir(
    state: State<'_, AppState>,
    dir: String,
) -> Result<FileIndexStorageInfo, OmniError> {
    let normalized = dir.trim().to_string();
    {
        let current = state.file_index_storage_dir.lock().await.clone();
        if current == normalized {
            let storage = state.file_index_storage.lock().await;
            return build_storage_info(&normalized, &storage);
        }
    }

    cancel_all_file_index_tasks(state.inner());

    let new_storage = FileIndexStorage::open_at_dir(&normalized).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "无法打开文件索引存储").with_cause(e.to_string())
    })?;

    {
        let mut guard = state.file_index_storage.lock().await;
        *guard = new_storage;
    }
    {
        let mut dir_guard = state.file_index_storage_dir.lock().await;
        *dir_guard = normalized.clone();
    }

    let storage = state.file_index_storage.lock().await;
    build_storage_info(&normalized, &storage)
}
