//! 大日志预览/跟踪共享类型与实现（本地 FS + SFTP）。

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::{shell_single_quote, StreamChunk, SshSession, SshStreamHandle};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSessionInfo {
    #[specta(type = f64)]
    pub size_bytes: u64,
    #[specta(type = Option<f64>)]
    pub total_lines: Option<u64>,
    pub lines_estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    #[specta(type = f64)]
    pub line_no: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogTailHandle {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogTailChunk {
    pub token: String,
    pub lines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchOptions {
    pub is_regex: Option<bool>,
    #[specta(type = Option<f64>)]
    pub max_results: Option<u32>,
    #[specta(type = Option<f64>)]
    pub context_before: Option<u32>,
    #[specta(type = Option<f64>)]
    pub context_after: Option<u32>,
    pub reverse: Option<bool>,
    #[specta(type = Option<f64>)]
    pub before_line: Option<u64>,
    #[specta(type = Option<f64>)]
    pub after_line: Option<u64>,
    #[specta(type = Option<f64>)]
    pub total_lines_hint: Option<u64>,
    #[specta(type = Option<f64>)]
    pub skip_matches: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchHit {
    #[specta(type = f64)]
    pub line_no: u64,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub match_start: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub match_end: Option<usize>,
}

pub fn new_log_token(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos}")
}

async fn estimate_line_count(session: &SshSession, path: &str, size: u64) -> Option<u64> {
    if size == 0 {
        return Some(0);
    }
    let sample = size.min(1024 * 1024);
    let cmd = format!("head -c {sample} {} | wc -lc", shell_single_quote(path));
    let out = session.exec_capture(&cmd).await.ok()?;
    let mut parts = out.stdout.split_whitespace();
    let lines: u64 = parts.next()?.parse().ok()?;
    let bytes: u64 = parts.next()?.parse().ok()?;
    if bytes == 0 {
        return None;
    }
    if lines == 0 {
        return Some((size / 80).max(1));
    }
    let est = ((size as f64) * (lines as f64) / (bytes as f64)).round() as u64;
    Some(est.max(1))
}

pub async fn sftp_log_open(session: &SshSession, path: &str) -> OmniResult<LogSessionInfo> {
    let size = session.sftp_file_size(path).await.unwrap_or(0);
    let wc_cmd = format!("wc -l < {}", shell_single_quote(path));
    let (total_lines, lines_estimated) =
        match tokio::time::timeout(Duration::from_secs(3), session.exec_command(&wc_cmd)).await {
            Ok(Ok(s)) => match s.trim().parse::<u64>() {
                Ok(n) => (Some(n), false),
                Err(_) => (estimate_line_count(session, path, size).await, true),
            },
            _ => (estimate_line_count(session, path, size).await, true),
        };
    Ok(LogSessionInfo {
        size_bytes: size,
        total_lines,
        lines_estimated: lines_estimated && total_lines.is_some(),
    })
}

pub async fn sftp_log_read_lines(
    session: &SshSession,
    path: &str,
    start_line: f64,
    end_line: f64,
) -> OmniResult<Vec<LogLine>> {
    let start_line = start_line.max(0.0) as u64;
    let end_line = end_line.max(0.0) as u64;
    if start_line == 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "起始行号必须 >= 1"));
    }
    if end_line < start_line {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "结束行号不能小于起始行号",
        ));
    }
    const MAX_LINES_PER_CALL: u64 = 5_000;
    let safe_end = start_line + (end_line - start_line).min(MAX_LINES_PER_CALL - 1);
    let cmd = if start_line == 1 {
        format!("head -n {} {}", safe_end, shell_single_quote(path))
    } else {
        format!(
            "sed -n '{start},{end}p;{end}q' {}",
            shell_single_quote(path),
            start = start_line,
            end = safe_end,
        )
    };
    let output = match tokio::time::timeout(Duration::from_secs(30), session.exec_capture(&cmd)).await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(OmniError::new(
                ErrorCode::Timeout,
                "读取日志超时（文件过大或远端过慢）",
            ));
        }
    };
    let mut lines = Vec::new();
    let mut n = start_line;
    for text in output.stdout.lines() {
        lines.push(LogLine {
            line_no: n,
            text: text.to_string(),
        });
        n += 1;
    }
    Ok(lines)
}

pub async fn sftp_log_tail_initial(
    session: &SshSession,
    path: &str,
    lines: u32,
) -> OmniResult<Vec<LogLine>> {
    let n = lines.max(1).min(5_000);
    let cmd = format!("tail -n {n} {}", shell_single_quote(path));
    let output = session.exec_capture(&cmd).await?;
    let collected: Vec<String> = output.stdout.lines().map(|s| s.to_string()).collect();
    Ok(collected
        .into_iter()
        .enumerate()
        .map(|(i, text)| LogLine {
            line_no: 1 + i as u64,
            text,
        })
        .collect())
}

#[async_trait]
pub trait LogTailEventSink: Send + Sync {
    async fn emit_log_tail(&self, event_name: &str, chunk: LogTailChunk);
}

pub struct SftpLogTailController {
    streams: AsyncMutex<HashMap<String, SshStreamHandle>>,
}

impl SftpLogTailController {
    pub fn new() -> Self {
        Self {
            streams: AsyncMutex::new(HashMap::new()),
        }
    }

    pub async fn start(
        &self,
        session: Arc<SshSession>,
        path: String,
        lines_after: Option<u32>,
        sink: Arc<dyn LogTailEventSink>,
    ) -> OmniResult<LogTailHandle> {
        let n = lines_after.unwrap_or(0);
        let cmd = format!("tail -F -n {n} {}", shell_single_quote(&path));
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamChunk>();
        let handle = session
            .exec_stream(&cmd, tx)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "启动日志跟踪失败").with_cause(e.to_string()))?;

        let token = new_log_token("sftp-log");
        let event_name = format!("sftp-log-tail-{token}");
        let token_for_task = token.clone();
        let sink_task = sink.clone();

        tokio::spawn(async move {
            let mut line_buf: Vec<u8> = Vec::with_capacity(8192);
            while let Some(chunk) = rx.recv().await {
                match chunk {
                    StreamChunk::Stdout(b) | StreamChunk::Stderr(b) => {
                        line_buf.extend_from_slice(&b);
                        let mut lines: Vec<String> = Vec::new();
                        loop {
                            let Some(idx) = line_buf.iter().position(|&c| c == b'\n') else {
                                break;
                            };
                            let mut line: Vec<u8> = line_buf[..idx].to_vec();
                            if line.last() == Some(&b'\r') {
                                line.pop();
                            }
                            line_buf = line_buf[idx + 1..].to_vec();
                            lines.push(String::from_utf8_lossy(&line).into_owned());
                        }
                        if !lines.is_empty() {
                            sink_task
                                .emit_log_tail(
                                    &event_name,
                                    LogTailChunk {
                                        token: token_for_task.clone(),
                                        lines,
                                        exit_code: None,
                                        error: None,
                                    },
                                )
                                .await;
                        }
                    }
                    StreamChunk::Exit(code) => {
                        sink_task
                            .emit_log_tail(
                                &event_name,
                                LogTailChunk {
                                    token: token_for_task.clone(),
                                    lines: vec![],
                                    exit_code: Some(code),
                                    error: None,
                                },
                            )
                            .await;
                        break;
                    }
                    StreamChunk::Closed => {
                        sink_task
                            .emit_log_tail(
                                &event_name,
                                LogTailChunk {
                                    token: token_for_task.clone(),
                                    lines: vec![],
                                    exit_code: None,
                                    error: Some("stream closed".to_string()),
                                },
                            )
                            .await;
                        break;
                    }
                }
            }
        });

        self.streams.lock().await.insert(token.clone(), handle);
        Ok(LogTailHandle { token })
    }

    pub async fn stop(&self, token: &str) -> OmniResult<()> {
        let handle = {
            let mut map = self.streams.lock().await;
            map.remove(token)
        };
        if let Some(mut handle) = handle {
            handle.stop().await;
        }
        Ok(())
    }
}

impl Default for SftpLogTailController {
    fn default() -> Self {
        Self::new()
    }
}

type LocalTailMap = HashMap<String, Arc<AtomicBool>>;

fn local_tail_tasks() -> &'static Mutex<LocalTailMap> {
    static TASKS: OnceLock<Mutex<LocalTailMap>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn open_file(path: &str) -> OmniResult<File> {
    File::open(path).map_err(|e| {
        OmniError::new(ErrorCode::Io, format!("无法打开文件: {path}")).with_cause(e.to_string())
    })
}

fn meta_size(path: &str) -> OmniResult<u64> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| OmniError::new(ErrorCode::Io, "无法读取文件元数据").with_cause(e.to_string()))
}

fn estimate_lines_local(path: &str, size: u64) -> Option<u64> {
    if size == 0 {
        return Some(0);
    }
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    let mut bytes: u64 = 0;
    let mut lines: u64 = 0;
    const SAMPLE: u64 = 1024 * 1024;
    while bytes < SAMPLE {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        lines += 1;
    }
    if lines == 0 || bytes == 0 {
        return None;
    }
    Some((((size as f64) * (lines as f64) / (bytes as f64)).round() as u64).max(1))
}

fn count_lines_fast(path: &str, size: u64) -> (Option<u64>, bool) {
    const PRECISE_MAX: u64 = 32 * 1024 * 1024;
    if size <= PRECISE_MAX {
        if let Ok(file) = File::open(path) {
            let reader = BufReader::new(file);
            let mut n = 0u64;
            for line in reader.lines() {
                if line.is_err() {
                    break;
                }
                n += 1;
            }
            return (Some(n), false);
        }
    }
    (estimate_lines_local(path, size), true)
}

pub async fn local_log_open(path: String) -> OmniResult<LogSessionInfo> {
    tokio::task::spawn_blocking(move || {
        let size = meta_size(&path)?;
        let (total_lines, lines_estimated) = count_lines_fast(&path, size);
        Ok(LogSessionInfo {
            size_bytes: size,
            total_lines,
            lines_estimated: lines_estimated && total_lines.is_some(),
        })
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, e.to_string()))?
}

pub async fn local_log_read_lines(
    path: String,
    start_line: f64,
    end_line: f64,
) -> OmniResult<Vec<LogLine>> {
    tokio::task::spawn_blocking(move || {
        let start_line = start_line.max(0.0) as u64;
        let end_line = end_line.max(0.0) as u64;
        if start_line == 0 {
            return Err(OmniError::new(ErrorCode::InvalidInput, "起始行号必须 >= 1"));
        }
        if end_line < start_line {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "结束行号不能小于起始行号",
            ));
        }
        const MAX_LINES_PER_CALL: u64 = 5_000;
        let safe_end = start_line + (end_line - start_line).min(MAX_LINES_PER_CALL - 1);
        let file = open_file(&path)?;
        let reader = BufReader::new(file);
        let mut out = Vec::new();
        let mut n = 0u64;
        for line in reader.lines() {
            n += 1;
            if n < start_line {
                continue;
            }
            if n > safe_end {
                break;
            }
            let text = line.map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取日志行失败").with_cause(e.to_string())
            })?;
            out.push(LogLine { line_no: n, text });
        }
        Ok(out)
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, e.to_string()))?
}

pub async fn local_log_tail_initial(path: String, lines: u32) -> OmniResult<Vec<LogLine>> {
    tokio::task::spawn_blocking(move || {
        let n = lines.max(1).min(5_000) as usize;
        let file = open_file(&path)?;
        let mut reader = BufReader::new(file);
        let mut ring: VecDeque<String> = VecDeque::with_capacity(n);
        for line in reader.by_ref().lines() {
            let text = line.map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取日志行失败").with_cause(e.to_string())
            })?;
            if ring.len() == n {
                ring.pop_front();
            }
            ring.push_back(text);
        }
        Ok(ring
            .into_iter()
            .enumerate()
            .map(|(i, text)| LogLine {
                line_no: (i + 1) as u64,
                text,
            })
            .collect())
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, e.to_string()))?
}

pub async fn local_log_tail_start(
    path: String,
    lines_after: Option<u32>,
    sink: Arc<dyn LogTailEventSink>,
) -> OmniResult<LogTailHandle> {
    let token = new_log_token("local-log");
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut map = local_tail_tasks()
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "local log tail map poisoned"))?;
        map.insert(token.clone(), stop.clone());
    }

    let event_name = format!("local-log-tail-{token}");
    let token_for_task = token.clone();
    let _n = lines_after.unwrap_or(0);

    tokio::task::spawn_blocking(move || {
        let mut file = match open_file(&path) {
            Ok(f) => f,
            Err(e) => {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(sink.emit_log_tail(
                    &event_name,
                    LogTailChunk {
                        token: token_for_task,
                        lines: vec![],
                        exit_code: None,
                        error: Some(e.user_message()),
                    },
                ));
                return;
            }
        };
        let _ = file.seek(SeekFrom::End(0));
        let mut buf = String::new();
        let mut reader = BufReader::new(file);
        let rt = tokio::runtime::Handle::current();
        while !stop.load(Ordering::Relaxed) {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(400));
                    continue;
                }
                Ok(_) => {
                    let text = buf.trim_end_matches(['\r', '\n']).to_string();
                    rt.block_on(sink.emit_log_tail(
                        &event_name,
                        LogTailChunk {
                            token: token_for_task.clone(),
                            lines: vec![text],
                            exit_code: None,
                            error: None,
                        },
                    ));
                }
                Err(e) => {
                    rt.block_on(sink.emit_log_tail(
                        &event_name,
                        LogTailChunk {
                            token: token_for_task,
                            lines: vec![],
                            exit_code: None,
                            error: Some(e.to_string()),
                        },
                    ));
                    break;
                }
            }
        }
    });

    Ok(LogTailHandle { token })
}

pub async fn local_log_tail_stop(token: String) -> OmniResult<()> {
    if let Ok(mut map) = local_tail_tasks().lock() {
        if let Some(flag) = map.remove(&token) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
