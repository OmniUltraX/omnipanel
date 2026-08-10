//! SFTP 媒体探测与 HTTP Range 解析（边下边播共享逻辑）。

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};

use crate::{shell_single_quote, SshSession};
/// 无 Range 时单次最多回传的字节（图片 / 小音频全量 GET）。
pub const MEDIA_MAX_FULL_GET: u64 = 64 * 1024 * 1024;
/// 单次 SFTP 读取块上限。
pub const MEDIA_MAX_CHUNK: u32 = 4 * 1024 * 1024;

/// 远端媒体探测结果（不下载整文件）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpMediaProbe {
    pub duration_secs: Option<f64>,
    #[specta(type = Option<f64>)]
    pub size: Option<u64>,
    /// JPEG 封面的 data URL（无封面时为 null）
    pub poster_data_url: Option<String>,
}

/// 打开边下边播流后的句柄元数据。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpMediaStream {
    pub url: String,
    pub token: String,
    #[specta(type = f64)]
    pub size: u64,
    pub mime: String,
}

/// Range 代理注册项（按 token 索引）。
#[derive(Debug, Clone)]
pub struct MediaStreamEntry {
    pub ssh_id: String,
    pub remote_path: String,
    pub size: u64,
    pub mime: String,
}

/// 解析后的字节 Range（含首尾，闭区间）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

/// 根据文件名猜测 MIME。
pub fn guess_media_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" | "m4a" => "audio/mp4",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// 解析 `Range: bytes=...` 头；仅支持单段 Range。
pub fn parse_bytes_range_header(range_header: Option<&str>, size: u64) -> Option<ByteRange> {
    let value = range_header?;
    let spec = value.strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    if let Some((start_s, end_s)) = spec.split_once('-') {
        if start_s.is_empty() {
            let n: u64 = end_s.parse().ok()?;
            if n == 0 || size == 0 {
                return None;
            }
            let start = size.saturating_sub(n);
            return Some(ByteRange {
                start,
                end: size - 1,
            });
        }
        let start: u64 = start_s.parse().ok()?;
        if start >= size {
            return None;
        }
        let end = if end_s.is_empty() {
            size - 1
        } else {
            end_s.parse::<u64>().ok()?.min(size - 1)
        };
        if end < start {
            return None;
        }
        return Some(ByteRange { start, end });
    }
    None
}

/// 无 Range 时对大文件强制返回首段，避免整文件灌入内存。
pub fn resolve_media_byte_range(
    range_header: Option<&str>,
    size: u64,
) -> (bool, ByteRange) {
    if let Some(r) = parse_bytes_range_header(range_header, size) {
        return (true, r);
    }
    if size > MEDIA_MAX_FULL_GET {
        let end = (2 * 1024 * 1024 - 1).min(size - 1);
        (true, ByteRange { start: 0, end })
    } else {
        (false, ByteRange {
            start: 0,
            end: size.saturating_sub(1),
        })
    }
}

/// 从 SFTP 按偏移读取指定长度（自动分块）。
pub async fn sftp_read_bytes_range(
    session: &SshSession,
    remote_path: &str,
    offset: u64,
    len: u64,
) -> OmniResult<Vec<u8>> {
    let mut out = Vec::with_capacity(len.min(MEDIA_MAX_CHUNK as u64) as usize);
    let mut off = offset;
    let mut remaining = len;
    while remaining > 0 {
        let chunk = remaining.min(MEDIA_MAX_CHUNK as u64) as u32;
        let data = session.sftp_read_range(remote_path, off, chunk).await?;
        if data.is_empty() {
            break;
        }
        let n = data.len() as u64;
        off += n;
        remaining = remaining.saturating_sub(n);
        out.extend(data);
        if n < chunk as u64 {
            break;
        }
    }
    Ok(out)
}

pub fn path_looks_like_video(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".mp4", ".webm", ".m4v", ".mov", ".ogv"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

pub fn parse_wav_duration_secs(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 44 {
        return None;
    }
    if &bytes[0..4] != b"RIFF" && &bytes[0..4] != b"RF64" {
        return None;
    }
    if &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12usize;
    let mut byte_rate: Option<u32> = None;
    let mut data_size: Option<u32> = None;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().ok()?);
        let payload = i + 8;
        if id == b"fmt " && payload + 16 <= bytes.len() {
            byte_rate = Some(u32::from_le_bytes(
                bytes[payload + 8..payload + 12].try_into().ok()?,
            ));
        } else if id == b"data" {
            data_size = Some(size);
            break;
        }
        let step = 8u64 + u64::from(size) + (u64::from(size) & 1);
        i = i.checked_add(step as usize)?;
    }
    let rate = byte_rate.filter(|r| *r > 0)?;
    let data = data_size?;
    Some(f64::from(data) / f64::from(rate))
}

async fn probe_duration_ffprobe(session: &SshSession, path: &str) -> Option<f64> {
    let quoted = shell_single_quote(path);
    let cmd = format!(
        "ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 {quoted} 2>/dev/null"
    );
    let output = session.exec_capture(&cmd).await.ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let text = output.stdout.trim();
    let secs: f64 = text.parse().ok()?;
    if secs.is_finite() && secs >= 0.0 {
        Some(secs)
    } else {
        None
    }
}

async fn probe_poster_data_url(session: &SshSession, path: &str) -> Option<String> {
    if !path_looks_like_video(path) {
        return None;
    }
    let quoted = shell_single_quote(path);
    let cmd = format!(
        "ffmpeg -v error -ss 1 -i {quoted} -frames:v 1 -f image2pipe -vcodec mjpeg - 2>/dev/null | base64 -w 0 2>/dev/null || ffmpeg -v error -ss 1 -i {quoted} -frames:v 1 -f image2pipe -vcodec mjpeg - 2>/dev/null | base64 2>/dev/null"
    );
    let output = session.exec_capture(&cmd).await.ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let b64 = output.stdout.split_whitespace().collect::<String>();
    if b64.len() < 32 || b64.len() > 2_000_000 {
        return None;
    }
    if base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .is_err()
    {
        return None;
    }
    Some(format!("data:image/jpeg;base64,{b64}"))
}

/// 探测远端媒体时长/大小/封面：不下载整文件。
pub async fn probe_sftp_media(session: &SshSession, path: &str) -> SftpMediaProbe {
    let size = session.sftp_file_size(path).await;
    let mut duration_secs = probe_duration_ffprobe(session, path).await;
    if duration_secs.is_none() {
        if let Ok(bytes) = session.sftp_read_range(path, 0, 256 * 1024).await {
            duration_secs = parse_wav_duration_secs(&bytes);
        }
    }
    let poster_data_url = if path_looks_like_video(path) {
        probe_poster_data_url(session, path).await
    } else {
        None
    };
    SftpMediaProbe {
        duration_secs,
        size,
        poster_data_url,
    }
}

/// 供 HTTP 层使用的 Range 响应元数据。
#[derive(Debug, Clone)]
pub struct MediaRangeResponse {
    pub partial: bool,
    pub start: u64,
    pub end: u64,
    pub data: Vec<u8>,
    pub total_size: u64,
    pub mime: String,
}

impl MediaRangeResponse {
    pub fn content_length(&self) -> usize {
        self.data.len()
    }

    pub fn content_range_value(&self) -> Option<String> {
        if !self.partial || self.data.is_empty() {
            return None;
        }
        let actual_end = self.start + self.data.len() as u64 - 1;
        Some(format!(
            "bytes {}-{}/{}",
            self.start, actual_end, self.total_size
        ))
    }
}

/// 读取媒体 Range 字节（供 Web / 桌面 HTTP 代理共用）。
pub async fn read_media_range(
    session: &SshSession,
    entry: &MediaStreamEntry,
    range_header: Option<&str>,
) -> OmniResult<MediaRangeResponse> {
    let size = entry.size;
    if size == 0 {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::NotFound,
            "远端文件为空",
        ));
    }
    let (partial, range) = resolve_media_byte_range(range_header, size);
    let len = range.end - range.start + 1;
    let data = sftp_read_bytes_range(session, &entry.remote_path, range.start, len).await?;
    Ok(MediaRangeResponse {
        partial,
        start: range.start,
        end: range.end,
        data,
        total_size: size,
        mime: entry.mime.clone(),
    })
}

/// 会话提供者：按连接 id 获取 SSH 会话（桌面池 / Web 会话表实现）。
#[async_trait]
pub trait MediaSessionProvider: Send + Sync {
    async fn ssh_session(&self, connection_id: &str) -> OmniResult<Arc<SshSession>>;
}
