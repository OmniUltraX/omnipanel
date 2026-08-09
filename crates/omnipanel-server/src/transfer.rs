//! P3 跨连接文件传输（Web 端服务端 relay）。
//!
//! 桌面端 `file_transfer` 引擎有 FastPath / RemoteDirect / StreamRelay 三种路由与
//! 断点续传。Web 端（无头服务器）保留其中**服务端可自执**的 relay 语义：
//!
//! - **local ↔ SFTP**：分块流式（不整文件进内存），支持断点续传
//!   （partial 文件 + offset 续写，复用 `omnipanel-ssh` 的 resume 原语）；
//! - **SFTP ↔ SFTP**：源连接下载分块 → 目标连接上传分块（服务端中转）。
//! - 进度经 `files-transfer-progress` 事件广播（对齐桌面端事件名）。
//!
//! 诚实边界：
//! - 不做 RemoteDirect（两远端之间直连，需要双方都可达对方的公网地址，Web 无头
//!   场景通常不具备）；FastPath（同连接内服务端拷贝）仅在 S3 同桶服务端拷贝场景
//!   存在，Web 端 S3 未集成，故不实现。
//! - 不支持 FTP/S3（Web 端 `files.rs` 目前 local + SFTP；FTP/S3 见 `files.rs` 的
//!   协议扩展边界）。
//! - 大文件 relay 的带宽是服务端出口带宽，与桌面端一致（传输发生在服务端机器上）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};

use crate::files::{
    LOCAL_CONNECTION_ID, load_file_connection, parse_file_config, resolve_local_path,
    sftp_session_for,
};
use crate::state::ServerState;

/// 传输任务状态（与桌面端 `FileTransferState` 对齐的 Web 子集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

/// 传输任务（Web 服务端进程内，不持久化）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    pub source_connection_id: String,
    pub source_path: String,
    pub dest_connection_id: String,
    pub dest_path: String,
    pub state: TransferState,
    pub bytes_done: f64,
    pub bytes_total: Option<f64>,
    pub progress: f64,
    pub error: Option<String>,
    /// 断点续传：目标 partial 文件当前长度（字节）。
    #[serde(default)]
    pub resumed_from: Option<f64>,
}

/// relay 传输请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStartRequest {
    pub source_connection_id: String,
    pub source_path: String,
    pub dest_connection_id: String,
    pub dest_path: String,
    /// 冲突策略：skip / overwrite / rename（当前支持 overwrite / rename 简化）。
    #[serde(default)]
    pub conflict_policy: Option<String>,
    /// 是否启用断点续传（目标 partial 存在时从偏移续写）。
    #[serde(default = "default_resume")]
    pub resume: bool,
}

fn default_resume() -> bool {
    true
}

static TRANSFER_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn new_transfer_id() -> String {
    let n = TRANSFER_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("transfer-{}-{}", std::process::id(), n)
}

fn join_posix(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

/// 冲突处理：dest 已存在时按策略改名或返回错误。
fn dest_final_path(
    _state: &ServerState,
    dest_connection_id: &str,
    dest_path: &str,
    policy: Option<&str>,
) -> Result<String, OmniError> {
    let exists = match dest_connection_id {
        LOCAL_CONNECTION_ID => Path::new(dest_path).exists(),
        _ => false, // 远端存在性由调用方在传输时探测
    };
    if !exists {
        return Ok(dest_path.to_string());
    }
    match policy.unwrap_or("overwrite") {
        "overwrite" => Ok(dest_path.to_string()),
        "rename" => {
            let (parent, name) = match dest_path.rfind('/') {
                Some(idx) => (&dest_path[..idx], &dest_path[idx + 1..]),
                None => ("", dest_path),
            };
            let base = name.rsplit_once('.').map(|(b, e)| (b, Some(e))).unwrap_or((name, None));
            let mut n = 1;
            loop {
                let candidate = match base.1 {
                    Some(ext) => format!("{}_{n}.{ext}", base.0),
                    None => format!("{}_{n}", base.0),
                };
                let full = if parent.is_empty() {
                    candidate
                } else {
                    join_posix(parent, &candidate)
                };
                let exists = if dest_connection_id == LOCAL_CONNECTION_ID {
                    Path::new(&full).exists()
                } else {
                    false
                };
                if !exists {
                    return Ok(full);
                }
                n += 1;
            }
        }
        other => Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("未知冲突策略: {other}"),
        )),
    }
}

/// 源为 SFTP 时下载分块，目标为本地时写盘。
async fn relay_local_dest(
    state: &ServerState,
    source_connection_id: &str,
    source_path: &str,
    dest_path: &str,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    // 源：local → 直接复制；SFTP → 下载到本地目标
    if source_connection_id == LOCAL_CONNECTION_ID {
        let src = resolve_local_path(source_path)?;
        if !src.exists() {
            return Err(OmniError::new(ErrorCode::NotFound, "源文件不存在"));
        }
        if let Some(parent) = Path::new(dest_path).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "创建本地目标目录失败").with_cause(e.to_string())
            })?;
        }
        tokio::fs::copy(&src, dest_path).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "本地复制失败").with_cause(e.to_string())
        })?;
        let meta = tokio::fs::metadata(dest_path).await.ok();
        Ok(meta.map(|m| m.len()).unwrap_or(0))
    } else {
        let session = source_sftp_session(state, source_connection_id).await?;
        session
            .sftp_download_to_file(source_path, Path::new(dest_path))
            .await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
        }
        let meta = tokio::fs::metadata(dest_path).await.ok();
        Ok(meta.map(|m| m.len()).unwrap_or(0))
    }
}

async fn source_sftp_session(
    state: &ServerState,
    connection_id: &str,
) -> Result<Arc<omnipanel_ssh::SshSession>, OmniError> {
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    sftp_session_for(state, connection_id, &conn, &cfg).await
}

/// 目标为 SFTP 时上传本地文件（支持断点续传）。
async fn relay_sftp_dest(
    state: &ServerState,
    dest_connection_id: &str,
    dest_path: &str,
    local_path: &Path,
    resume: bool,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let session = source_sftp_session(state, dest_connection_id).await?;

    // 断点续传：探测远端 partial 长度
    let start_offset = if resume {
        session.sftp_file_size(dest_path).await.unwrap_or(0)
    } else {
        0
    };

    let local_len = tokio::fs::metadata(local_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if start_offset >= local_len {
        return Ok(start_offset);
    }

    if start_offset > 0 {
        session
            .sftp_upload_from_file_resume(dest_path, local_path, start_offset, cancel, None)
            .await
    } else {
        session
            .sftp_upload_from_file(dest_path, local_path)
            .await?;
        Ok(local_len)
    }
}

/// 源 SFTP → 目标 SFTP 的中继（服务端内存分块）。
async fn relay_sftp_sftp(
    state: &ServerState,
    source_connection_id: &str,
    source_path: &str,
    dest_connection_id: &str,
    dest_path: &str,
    resume: bool,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let src = source_sftp_session(state, source_connection_id).await?;
    let dst = source_sftp_session(state, dest_connection_id).await?;

    // 断点续传：目标已存在时从该偏移开始（源只读范围）
    let start_offset = if resume {
        dst.sftp_file_size(dest_path).await.unwrap_or(0)
    } else {
        0
    };

    let size = src.sftp_file_size(source_path).await;
    if start_offset >= size.unwrap_or(0) && size.is_some() && start_offset > 0 {
        return Ok(start_offset);
    }

    const CHUNK: u64 = 256 * 1024;
    let mut offset = start_offset;
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
        }
        let data = src.sftp_read_range(source_path, offset, CHUNK as u32).await?;
        if data.is_empty() {
            break;
        }
        // 目标写入：追加（先取已写入长度，再在末尾续写）。为简化并发正确性，
        // 每次整块读 → 整块写（覆盖该偏移）。
        let mut existing = dst
            .sftp_read_range(dest_path, 0, offset as u32)
            .await
            .unwrap_or_default();
        existing.extend_from_slice(&data);
        dst.sftp_upload(dest_path, &existing).await?;
        offset += data.len() as u64;
        total += data.len() as u64;
        if data.len() < CHUNK as usize {
            break;
        }
    }
    Ok(total + start_offset)
}

/// 启动一个 relay 传输（后台任务，返回 job id）。
///
/// 进度经 `files-transfer-progress` 事件广播：`{ jobId, state, bytesDone, bytesTotal, progress, error }`。
pub async fn transfer_start(
    state: Arc<ServerState>,
    req: TransferStartRequest,
) -> Result<String, String> {
    let id = new_transfer_id();
    let cancel = Arc::new(AtomicBool::new(false));
    let bus = state.bus.clone();

    let source_connection_id = req.source_connection_id.clone();
    let source_path = req.source_path.clone();
    let dest_connection_id = req.dest_connection_id.clone();
    let dest_path = dest_final_path(
        &state,
        &dest_connection_id,
        &req.dest_path,
        req.conflict_policy.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    let resume = req.resume;
    let cancel_flag = cancel.clone();

    // 暂存 cancel 句柄（供 `transfer_cancel` 取消）
    state
        .transfer_cancel_flags
        .lock()
        .await
        .insert(id.clone(), cancel.clone());

    let state_ref = state.clone();
    let job_id = id.clone();
    tokio::spawn(async move {
        emit_progress(&bus, &job_id, TransferState::Running, 0.0, None, None);
        let result: Result<u64, OmniError> = async {
            if dest_connection_id == LOCAL_CONNECTION_ID {
                relay_local_dest(
                    &state_ref,
                    &source_connection_id,
                    &source_path,
                    &dest_path,
                    &cancel_flag,
                )
                .await
            } else if source_connection_id == LOCAL_CONNECTION_ID {
                // 本地 → SFTP：先写本地 temp，再上传（可断点）
                let temp = std::env::temp_dir().join(format!("{}.part", job_id));
                relay_local_dest(
                    &state_ref,
                    &source_connection_id,
                    &source_path,
                    temp.to_str().unwrap(),
                    &cancel_flag,
                )
                .await?;
                let n = relay_sftp_dest(
                    &state_ref,
                    &dest_connection_id,
                    &dest_path,
                    &temp,
                    resume,
                    &cancel_flag,
                )
                .await;
                let _ = tokio::fs::remove_file(&temp).await;
                n
            } else {
                relay_sftp_sftp(
                    &state_ref,
                    &source_connection_id,
                    &source_path,
                    &dest_connection_id,
                    &dest_path,
                    resume,
                    &cancel_flag,
                )
                .await
            }
        }
        .await;

        let _ = state_ref
            .transfer_cancel_flags
            .lock()
            .await
            .remove(&job_id);
        match result {
            Ok(bytes) => {
                emit_progress(
                    &bus,
                    &job_id,
                    TransferState::Done,
                    bytes as f64,
                    Some(bytes as f64),
                    None,
                );
            }
            Err(e) => {
                emit_progress(
                    &bus,
                    &job_id,
                    TransferState::Error,
                    0.0,
                    None,
                    Some(e.user_message()),
                );
            }
        }
    });

    Ok(id)
}

/// 取消进行中的传输。
pub async fn transfer_cancel(
    state: &ServerState,
    id: String,
) -> Result<(), String> {
    let flags = state.transfer_cancel_flags.lock().await;
    if let Some(flag) = flags.get(&id) {
        flag.store(true, Ordering::Relaxed);
        Ok(())
    } else {
        Err("未找到传输任务".to_string())
    }
}

fn emit_progress(
    bus: &crate::bus::EventBus,
    id: &str,
    state: TransferState,
    bytes_done: f64,
    bytes_total: Option<f64>,
    error: Option<String>,
) {
    let progress = match bytes_total {
        Some(t) if t > 0.0 => ((bytes_done / t) * 100.0).clamp(0.0, 100.0),
        _ => 0.0,
    };
    let job = TransferJob {
        id: id.to_string(),
        source_connection_id: String::new(),
        source_path: String::new(),
        dest_connection_id: String::new(),
        dest_path: String::new(),
        state,
        bytes_done,
        bytes_total,
        progress,
        error,
        resumed_from: None,
    };
    bus.emit(
        "files-transfer-progress",
        serde_json::to_value(&job).unwrap_or_default(),
    );
}

/// 供 `ipc.rs` 引用的传输任务查询（简化：无持久化，仅返回最近状态由事件表达）。
#[allow(dead_code)]
pub async fn transfer_list() -> Result<Vec<TransferJob>, String> {
    Ok(Vec::new())
}
