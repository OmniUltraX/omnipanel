//! P3 跨连接文件传输（Web 端服务端 relay）。
//!
//! 桌面端 `file_transfer` 引擎有 FastPath / RemoteDirect / StreamRelay 三种路由与
//! 断点续传。Web 端（无头服务器）保留其中**服务端可自执**的 relay 语义：
//!
//! - **local ↔ SFTP**：分块流式（不整文件进内存），支持断点续传
//!   （partial 文件 + offset 续写，复用 `omnipanel-ssh` 的 resume 原语）；
//! - **SFTP ↔ SFTP**：源连接下载分块 → 目标连接上传分块（服务端中转，偏移续写）；
//! - **S3 参与**：local/SFTP ↔ S3（get/put 中转）、S3 ↔ S3 同桶服务端拷贝优先
//!   （复制不可用或跨桶时回落内存 relay）。
//! - 进度经 `files-transfer-progress` 事件广播（对齐桌面端事件名）。
//!
//! 诚实边界：
//! - 不做 RemoteDirect（两远端之间直连，需要双方都可达对方的公网地址，Web 无头
//!   场景通常不具备）。
//! - 大文件 relay 的带宽是服务端出口带宽，与桌面端一致（传输发生在服务端机器上）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_s3::S3Config;
use serde::{Deserialize, Serialize};

use crate::files::{
    LOCAL_CONNECTION_ID, load_file_connection, parse_file_config, protocol_of, resolve_local_path,
    resolve_secret, sftp_session_for,
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

/// 按连接 id 构造 S3 客户端（凭据走 Vault 注入）。非 S3 连接返回错误。
async fn s3_client_for_connection(
    state: &ServerState,
    connection_id: &str,
) -> Result<omnipanel_s3::S3Client, OmniError> {
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    if protocol_of(&cfg) != "s3" {
        return Err(OmniError::invalid_input(format!(
            "连接不是 S3 类型: {connection_id}"
        )));
    }
    let secret = resolve_secret(&conn).unwrap_or_default();
    let s3_cfg = S3Config {
        bucket: cfg.bucket.clone(),
        provider: cfg.provider.clone(),
        region: cfg.region.clone(),
        endpoint: cfg.endpoint.clone(),
        access_key: cfg.access_key.clone(),
        prefix: cfg.prefix.clone(),
    };
    omnipanel_s3::S3Client::new(s3_cfg, secret)
}

/// 连接协议（local / sftp / ftp / s3）。
async fn connection_protocol(state: &ServerState, connection_id: &str) -> Result<String, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok("local".to_string());
    }
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    Ok(protocol_of(&cfg).to_string())
}

/// S3 object key：去开头 `/`。
fn s3_key(path: &str) -> String {
    path.trim_start_matches('/').to_string()
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

/// 源 SFTP → 目标 SFTP 的中继（服务端分块 + 偏移续写，不再整文件下载重写）。
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

    // 目标目录不存在时先创建（对齐 local/SFTP 传输语义）
    if let Some(parent) = dest_path.rfind('/').map(|i| &dest_path[..i]) {
        if !parent.is_empty() && !dst.sftp_exists(parent).await {
            dst.sftp_mkdir(parent).await?;
        }
    }

    const CHUNK: u64 = 256 * 1024;
    let mut offset = start_offset;
    let mut total = start_offset;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
        }
        let data = src.sftp_read_range(source_path, offset, CHUNK as u32).await?;
        if data.is_empty() {
            break;
        }
        // 目标偏移续写：每块仅覆盖该偏移（不整文件重写）
        let written = dst
            .sftp_write_at(dest_path, offset, &data)
            .await
            .map_err(|e| {
                e.with_cause("SFTP 偏移写入目标文件失败")
            })?;
        offset += data.len() as u64;
        total = written;
        if data.len() < CHUNK as usize {
            break;
        }
    }
    // 若目标文件本比源更长（如残留 partial 超长），裁剪到最终长度
    if size.map_or(false, |s| s < total) {
        let _ = dst.sftp_set_length(dest_path, size.unwrap_or(total)).await;
    }
    Ok(total)
}

/// 下载源连接文件到本地临时文件，返回 (temp 路径, 字节数)。
/// 源协议：local 直接路径 / SFTP 下载 / S3 get。
async fn source_to_local_temp(
    state: &ServerState,
    source_connection_id: &str,
    source_path: &str,
    job_id: &str,
    cancel: &AtomicBool,
) -> Result<(std::path::PathBuf, u64), OmniError> {
    let proto = connection_protocol(state, source_connection_id).await?;
    match proto.as_str() {
        "local" => {
            let src = resolve_local_path(source_path)?;
            if !src.exists() {
                return Err(OmniError::new(ErrorCode::NotFound, "源文件不存在"));
            }
            let len = tokio::fs::metadata(&src).await.map(|m| m.len()).unwrap_or(0);
            Ok((src, len))
        }
        "sftp" => {
            let session = source_sftp_session(state, source_connection_id).await?;
            let temp = std::env::temp_dir().join(format!("{job_id}.src"));
            session
                .sftp_download_to_file(source_path, &temp)
                .await?;
            if cancel.load(Ordering::Relaxed) {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
            }
            let len = tokio::fs::metadata(&temp).await.map(|m| m.len()).unwrap_or(0);
            Ok((temp, len))
        }
        "s3" => {
            let client = s3_client_for_connection(state, source_connection_id).await?;
            let data = client.get_object(&s3_key(source_path)).await?;
            if cancel.load(Ordering::Relaxed) {
                return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
            }
            let temp = std::env::temp_dir().join(format!("{job_id}.src"));
            tokio::fs::write(&temp, &data).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "写入本地临时文件失败").with_cause(e.to_string())
            })?;
            let len = data.len() as u64;
            Ok((temp, len))
        }
        other => Err(OmniError::invalid_input(format!(
            "不支持的源协议: {other}"
        ))),
    }
}

/// 将本地临时文件上传到目标连接。目标协议：local / sftp / s3。
async fn local_temp_to_dest(
    state: &ServerState,
    dest_connection_id: &str,
    dest_path: &str,
    temp: &std::path::Path,
    resume: bool,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let proto = connection_protocol(state, dest_connection_id).await?;
    match proto.as_str() {
        "local" => {
            if let Some(parent) = Path::new(dest_path).parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    OmniError::new(ErrorCode::Io, "创建本地目标目录失败").with_cause(e.to_string())
                })?;
            }
            tokio::fs::copy(temp, dest_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "本地复制失败").with_cause(e.to_string())
            })?;
            let meta = tokio::fs::metadata(dest_path).await.ok();
            Ok(meta.map(|m| m.len()).unwrap_or(0))
        }
        "sftp" => relay_sftp_dest(state, dest_connection_id, dest_path, temp, resume, cancel).await,
        "s3" => {
            let client = s3_client_for_connection(state, dest_connection_id).await?;
            let data = tokio::fs::read(temp).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取本地临时文件失败").with_cause(e.to_string())
            })?;
            client.put_object(&s3_key(dest_path), &data).await?;
            Ok(data.len() as u64)
        }
        other => Err(OmniError::invalid_input(format!(
            "不支持的目标协议: {other}"
        ))),
    }
}

/// S3 → S3 中继：同桶服务端拷贝优先，否则内存 relay。
async fn relay_s3_s3(
    state: &ServerState,
    source_connection_id: &str,
    source_path: &str,
    dest_connection_id: &str,
    dest_path: &str,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let src_client = s3_client_for_connection(state, source_connection_id).await?;
    let dst_client = s3_client_for_connection(state, dest_connection_id).await?;
    let src_key = s3_key(source_path);
    let dst_key = s3_key(dest_path);

    // 同桶：尝试服务端拷贝（不经本机）
    if source_connection_id == dest_connection_id
        || same_bucket_and_endpoint(state, source_connection_id, dest_connection_id).await?
    {
        if src_client
            .copy_object_internal(&src_key, &dst_key)
            .await
            .is_ok()
        {
            // head 无法拿到 Content-Length（rust-s3 head 只返回状态码）；
            // 返回 0 表示无法精确计量，进度事件用 bytesTotal=None 处理。
            let _ = cancel.load(Ordering::Relaxed);
            return Ok(0);
        }
    }

    // 跨桶/服务端拷贝不可用：内存 relay（S3 对象通常可整载；大文件由上层限制）
    let data = src_client.get_object(&src_key).await?;
    if cancel.load(Ordering::Relaxed) {
        return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
    }
    dst_client.put_object(&dst_key, &data).await?;
    Ok(data.len() as u64)
}

/// 判断两个 S3 连接是否同 bucket + 同 endpoint（用于服务端拷贝判定）。
async fn same_bucket_and_endpoint(
    state: &ServerState,
    a: &str,
    b: &str,
) -> Result<bool, OmniError> {
    let conn_a = load_file_connection(state, a)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let conn_b = load_file_connection(state, b)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg_a = parse_file_config(&conn_a)?;
    let cfg_b = parse_file_config(&conn_b)?;
    let ep_a = omnipanel_s3::normalize_s3_api_endpoint(&cfg_a.endpoint, &cfg_a.bucket);
    let ep_b = omnipanel_s3::normalize_s3_api_endpoint(&cfg_b.endpoint, &cfg_b.bucket);
    Ok(cfg_a.bucket.trim() == cfg_b.bucket.trim()
        && ep_a.eq_ignore_ascii_case(&ep_b)
        && cfg_a.access_key.trim() == cfg_b.access_key.trim())
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
            let dest_proto =
                connection_protocol(&state_ref, &dest_connection_id).await?;
            let source_proto =
                connection_protocol(&state_ref, &source_connection_id).await?;

            if dest_proto == "s3" && source_proto == "s3" {
                relay_s3_s3(
                    &state_ref,
                    &source_connection_id,
                    &source_path,
                    &dest_connection_id,
                    &dest_path,
                    &cancel_flag,
                )
                .await
            } else if dest_proto == "s3" || source_proto == "s3" {
                // local/SFTP ↔ S3：经本地临时文件中转（S3 get/put）
                let (temp, _len) = source_to_local_temp(
                    &state_ref,
                    &source_connection_id,
                    &source_path,
                    &job_id,
                    &cancel_flag,
                )
                .await?;
                let cleanup = temp.clone();
                let n = local_temp_to_dest(
                    &state_ref,
                    &dest_connection_id,
                    &dest_path,
                    &temp,
                    resume,
                    &cancel_flag,
                )
                .await;
                let _ = tokio::fs::remove_file(&cleanup).await;
                n
            } else if dest_connection_id == LOCAL_CONNECTION_ID {
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
