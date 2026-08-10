//! Web 端大日志 / 媒体预览薄适配（共享逻辑在 `omnipanel-ssh`）。

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{
    log_tail::{
        local_log_open as ssh_local_log_open,
        local_log_read_lines as ssh_local_log_read_lines,
        local_log_tail_initial as ssh_local_log_tail_initial,
        local_log_tail_start as ssh_local_log_tail_start,
        local_log_tail_stop as ssh_local_log_tail_stop,
        new_log_token, sftp_log_open as ssh_sftp_log_open,
        sftp_log_read_lines as ssh_sftp_log_read_lines,
        sftp_log_tail_initial as ssh_sftp_log_tail_initial, LogLine, LogSessionInfo,
        LogTailChunk, LogTailEventSink, LogTailHandle, SftpLogTailController,
    },
    media::{guess_media_mime, probe_sftp_media, MediaStreamEntry, SftpMediaProbe, SftpMediaStream},
    SshSession,
};

use crate::bus::EventBus;
use crate::files::{load_file_connection, parse_file_config, protocol_of, sftp_session_for};
use crate::state::{resolve_ssh_config, ServerState};

struct ServerLogTailSink(EventBus);

#[async_trait]
impl LogTailEventSink for ServerLogTailSink {
    async fn emit_log_tail(&self, event_name: &str, chunk: LogTailChunk) {
        self.0.emit(
            event_name,
            serde_json::to_value(&chunk).unwrap_or_default(),
        );
    }
}

fn sftp_tail_controller() -> &'static SftpLogTailController {
    static CTRL: OnceLock<SftpLogTailController> = OnceLock::new();
    CTRL.get_or_init(SftpLogTailController::new)
}

async fn resolve_log_session(
    state: &ServerState,
    id: &str,
) -> OmniResult<Arc<SshSession>> {
    {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(id) {
            if !session.is_closed() {
                return Ok(session.clone());
            }
        }
    }
    {
        let pool = state.file_sftp_sessions.lock().await;
        if let Some(session) = pool.get(id) {
            if !session.is_closed() {
                return Ok(session.clone());
            }
        }
    }
    let conn = load_file_connection(state, id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    if protocol_uses_sftp(&cfg) {
        return sftp_session_for(state, id, &conn, &cfg).await;
    }
    let ssh_cfg = resolve_ssh_config(&conn)?;
    let session = Arc::new(
        SshSession::connect_no_shell(ssh_cfg)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "SSH 连接失败").with_cause(e.to_string()))?,
    );
    state
        .ssh_sessions
        .lock()
        .await
        .insert(id.to_string(), session.clone());
    Ok(session)
}

fn protocol_uses_sftp(cfg: &crate::files::FileConnConfig) -> bool {
    protocol_of(cfg) == "sftp"
}

pub async fn resolve_log_session_for_media(
    state: &ServerState,
    id: &str,
) -> OmniResult<Arc<SshSession>> {
    resolve_log_session(state, id).await
}

pub async fn sftp_log_open(
    state: &ServerState,
    id: String,
    path: String,
) -> OmniResult<LogSessionInfo> {
    let session = resolve_log_session(state, &id).await?;
    ssh_sftp_log_open(session.as_ref(), &path).await
}

pub async fn sftp_log_read_lines(
    state: &ServerState,
    id: String,
    path: String,
    start_line: f64,
    end_line: f64,
) -> OmniResult<Vec<LogLine>> {
    let session = resolve_log_session(state, &id).await?;
    ssh_sftp_log_read_lines(session.as_ref(), &path, start_line, end_line).await
}

pub async fn sftp_log_tail_initial(
    state: &ServerState,
    id: String,
    path: String,
    lines: u32,
) -> OmniResult<Vec<LogLine>> {
    let session = resolve_log_session(state, &id).await?;
    ssh_sftp_log_tail_initial(session.as_ref(), &path, lines).await
}

pub async fn sftp_log_tail_start(
    state: &ServerState,
    id: String,
    path: String,
    lines_after: Option<u32>,
) -> OmniResult<LogTailHandle> {
    let session = resolve_log_session(state, &id).await?;
    let sink: Arc<dyn LogTailEventSink> = Arc::new(ServerLogTailSink(state.bus.clone()));
    sftp_tail_controller()
        .start(session, path, lines_after, sink)
        .await
}

pub async fn sftp_log_tail_stop(state: &ServerState, token: String) -> OmniResult<()> {
    let _ = state;
    sftp_tail_controller().stop(&token).await
}

pub async fn local_log_open(path: String) -> OmniResult<LogSessionInfo> {
    ssh_local_log_open(path).await
}

pub async fn local_log_read_lines(
    path: String,
    start_line: f64,
    end_line: f64,
) -> OmniResult<Vec<LogLine>> {
    ssh_local_log_read_lines(path, start_line, end_line).await
}

pub async fn local_log_tail_initial(path: String, lines: u32) -> OmniResult<Vec<LogLine>> {
    ssh_local_log_tail_initial(path, lines).await
}

pub async fn local_log_tail_start(
    state: &ServerState,
    path: String,
    lines_after: Option<u32>,
) -> OmniResult<LogTailHandle> {
    let sink: Arc<dyn LogTailEventSink> = Arc::new(ServerLogTailSink(state.bus.clone()));
    ssh_local_log_tail_start(path, lines_after, sink).await
}

pub async fn local_log_tail_stop(token: String) -> OmniResult<()> {
    ssh_local_log_tail_stop(token).await
}

/// 小文件预览仍走本地缓存（大媒体请用 `sftp_open_media_stream`）。
pub async fn sftp_cache_for_preview(
    state: &ServerState,
    id: String,
    path: String,
    size: Option<f64>,
) -> OmniResult<String> {
    let size_u64 = size.map(|n| n.max(0.0) as u64);
    let local = media_cache_path(&id, &path, size_u64)?;
    if local.is_file() {
        if let Some(expected) = size_u64 {
            if let Ok(meta) = std::fs::metadata(&local) {
                if meta.len() == expected {
                    return Ok(local.to_string_lossy().into_owned());
                }
            }
        } else {
            return Ok(local.to_string_lossy().into_owned());
        }
    }
    let session = resolve_log_session(state, &id).await?;
    session.sftp_download_to_file(&path, &local).await?;
    Ok(local.to_string_lossy().into_owned())
}

fn media_cache_path(
    id: &str,
    path: &str,
    size: Option<u64>,
) -> OmniResult<std::path::PathBuf> {
    let base = std::env::temp_dir().join("omnipanel-media-cache");
    let safe_id: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let safe_path: String = path
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '/' || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut name = format!("{safe_id}-{safe_path}");
    if let Some(sz) = size {
        name.push_str(&format!("-{sz}"));
    }
    Ok(base.join(name))
}

pub async fn sftp_probe_media(
    state: &ServerState,
    id: String,
    path: String,
) -> OmniResult<SftpMediaProbe> {
    let session = resolve_log_session(state, &id).await?;
    Ok(probe_sftp_media(session.as_ref(), &path).await)
}

pub async fn sftp_open_media_stream(
    state: &ServerState,
    id: String,
    path: String,
) -> OmniResult<SftpMediaStream> {
    let session = resolve_log_session(state, &id).await?;
    let size = session.sftp_file_size(&path).await.unwrap_or(0);
    let token = new_log_token("media");
    let mime = guess_media_mime(&path).to_string();
    state.media_streams.lock().await.insert(
        token.clone(),
        MediaStreamEntry {
            ssh_id: id,
            remote_path: path,
            size,
            mime: mime.clone(),
        },
    );
    Ok(SftpMediaStream {
        url: format!("/media/{token}"),
        token,
        size,
        mime,
    })
}

pub async fn sftp_close_media_stream(state: &ServerState, token: String) -> OmniResult<()> {
    state.media_streams.lock().await.remove(&token);
    Ok(())
}
