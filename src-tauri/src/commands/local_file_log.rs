//! 本地大日志 Tauri IPC 薄适配（tail/follow 在 `omnipanel-ssh::log_tail`；搜索仍本地实现）。

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::log_tail::{
    LogTailChunk, LogTailEventSink, local_log_open as ssh_local_log_open,
    local_log_read_lines as ssh_local_log_read_lines,
    local_log_tail_initial as ssh_local_log_tail_initial,
    local_log_tail_start as ssh_local_log_tail_start,
    local_log_tail_stop as ssh_local_log_tail_stop,
};
use regex::Regex;
use tauri::{AppHandle, Emitter};

pub use crate::commands::ssh::{
    LogLine, LogSearchHit, LogSearchOptions, LogSessionInfo, LogTailHandle,
};

struct TauriLogTailSink(AppHandle);

#[async_trait]
impl LogTailEventSink for TauriLogTailSink {
    async fn emit_log_tail(&self, event_name: &str, chunk: LogTailChunk) {
        let _ = self.0.emit(event_name, &chunk);
    }
}

fn open_file(path: &str) -> Result<File, OmniError> {
    File::open(path).map_err(|e| {
        OmniError::new(ErrorCode::Io, format!("无法打开文件: {path}")).with_cause(e.to_string())
    })
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_open(path: String) -> Result<LogSessionInfo, OmniError> {
    ssh_local_log_open(path).await
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_read_lines(
    path: String,
    start_line: f64,
    end_line: f64,
) -> Result<Vec<LogLine>, OmniError> {
    ssh_local_log_read_lines(path, start_line, end_line).await
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_tail_initial(
    path: String,
    n_lines: u32,
    total_lines_hint: Option<f64>,
) -> Result<Vec<LogLine>, OmniError> {
    let mut lines = ssh_local_log_tail_initial(path, n_lines).await?;
    if let Some(hint) = total_lines_hint.map(|v| v.max(0.0) as u64) {
        let start = hint
            .saturating_sub(lines.len() as u64)
            .saturating_add(1)
            .max(1);
        for (i, line) in lines.iter_mut().enumerate() {
            line.line_no = start + i as u64;
        }
    }
    Ok(lines)
}

fn match_line(
    text: &str,
    pattern: &str,
    is_regex: bool,
    re: &Option<Regex>,
) -> Option<(usize, usize)> {
    if is_regex {
        let re = re.as_ref()?;
        let m = re.find(text)?;
        Some((m.start(), m.end()))
    } else {
        let idx = text.find(pattern)?;
        Some((idx, idx + pattern.len()))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_search(
    path: String,
    pattern: String,
    options: Option<LogSearchOptions>,
) -> Result<Vec<LogSearchHit>, OmniError> {
    const DEFAULT_MAX: u32 = 200;
    const ABSOLUTE_MAX: u32 = 5_000;
    let opts = options.unwrap_or_default();
    let is_regex = opts.is_regex.unwrap_or(false);
    let max = opts.max_results.unwrap_or(DEFAULT_MAX).min(ABSOLUTE_MAX) as usize;
    let reverse = opts.reverse.unwrap_or(false);
    let before = opts.before_line.filter(|&n| n > 1);
    let after = opts.after_line.filter(|&n| n > 0);
    let skip = opts.skip_matches.unwrap_or(0) as usize;

    if pattern.is_empty() {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let re = if is_regex {
            Some(Regex::new(&pattern).map_err(|e| {
                OmniError::new(ErrorCode::InvalidInput, "无效正则").with_cause(e.to_string())
            })?)
        } else {
            None
        };

        let file = open_file(&path)?;
        let reader = BufReader::new(file);
        let mut ring: VecDeque<LogSearchHit> = VecDeque::new();
        let mut line_no = 0u64;
        let mut skipped = 0usize;
        let need = skip + max;

        for line in reader.lines() {
            let text = line.map_err(|e| {
                OmniError::new(ErrorCode::Io, "搜索日志失败").with_cause(e.to_string())
            })?;
            line_no += 1;
            if let Some(b) = before {
                if line_no >= b {
                    break;
                }
            }
            if let Some(a) = after {
                if line_no <= a {
                    continue;
                }
            }
            let Some((ms, me)) = match_line(&text, &pattern, is_regex, &re) else {
                continue;
            };
            let hit = LogSearchHit {
                line_no,
                content: text.trim_end_matches('\r').to_string(),
                match_start: Some(ms),
                match_end: Some(me),
            };
            if reverse {
                ring.push_back(hit);
                if ring.len() > need {
                    ring.pop_front();
                }
            } else if skipped < skip {
                skipped += 1;
            } else {
                ring.push_back(hit);
                if ring.len() >= max {
                    break;
                }
            }
        }

        let hits: Vec<LogSearchHit> = if reverse {
            let mut v: Vec<_> = ring.into_iter().collect();
            if v.len() > skip {
                v = v[v.len() - skip - max.min(v.len().saturating_sub(skip))..].to_vec();
                if v.len() > max {
                    v = v[v.len() - max..].to_vec();
                }
            } else if skip > 0 {
                v.clear();
            }
            v
        } else {
            ring.into_iter().collect()
        };
        Ok(hits)
    })
    .await
    .map_err(|e| {
        OmniError::new(ErrorCode::Internal, "本地日志搜索任务失败").with_cause(e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_tail_start(
    app_handle: AppHandle,
    path: String,
    lines_after: Option<u32>,
) -> Result<LogTailHandle, OmniError> {
    let sink: std::sync::Arc<dyn LogTailEventSink> =
        std::sync::Arc::new(TauriLogTailSink(app_handle));
    ssh_local_log_tail_start(path, lines_after, sink).await
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_tail_stop(token: String) -> Result<(), OmniError> {
    ssh_local_log_tail_stop(token).await
}
