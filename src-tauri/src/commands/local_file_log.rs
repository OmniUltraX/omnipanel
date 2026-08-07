//! 本地大日志：纯 Rust 按行切片 / 搜索 / 轮询跟踪（跨平台，不依赖 sed/grep）。

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use regex::Regex;
use tauri::{AppHandle, Emitter};

use crate::commands::ssh::{
    LogLine, LogSearchHit, LogSearchOptions, LogSessionInfo, LogTailChunk, LogTailHandle,
};

type LocalTailMap = HashMap<String, Arc<AtomicBool>>;

fn local_tail_tasks() -> &'static Mutex<LocalTailMap> {
    static TASKS: OnceLock<Mutex<LocalTailMap>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn new_local_log_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("local-log-{nanos}")
}

fn open_file(path: &str) -> Result<File, OmniError> {
    File::open(path).map_err(|e| {
        OmniError::new(ErrorCode::Io, format!("无法打开文件: {path}")).with_cause(e.to_string())
    })
}

fn meta_size(path: &str) -> Result<u64, OmniError> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| OmniError::new(ErrorCode::Io, "无法读取文件元数据").with_cause(e.to_string()))
}

/// 采样估算行数：读文件头最多 1MB，按平均行长外推。
fn estimate_lines(path: &str, size: u64) -> Option<u64> {
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
    let est = ((size as f64) * (lines as f64) / (bytes as f64)).round() as u64;
    Some(est.max(1))
}

/// 精确计数（带超时预算：超过约 3s 的数据量则放弃，改估算）。
fn count_lines_fast(path: &str, size: u64) -> (Option<u64>, bool) {
    // 小文件直接精确数
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
    (estimate_lines(path, size), true)
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_open(path: String) -> Result<LogSessionInfo, OmniError> {
    let path_clone = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let size = meta_size(&path_clone)?;
        let (total_lines, lines_estimated) = count_lines_fast(&path_clone, size);
        let lines_estimated = lines_estimated && total_lines.is_some();
        Ok(LogSessionInfo {
            size_bytes: size,
            total_lines,
            lines_estimated,
        })
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, "本地日志探测任务失败").with_cause(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_read_lines(
    path: String,
    start_line: f64,
    end_line: f64,
) -> Result<Vec<LogLine>, OmniError> {
    let start_line = start_line.max(0.0) as u64;
    let end_line = end_line.max(0.0) as u64;
    if start_line == 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "起始行号必须 ≥ 1"));
    }
    if end_line < start_line {
        return Err(OmniError::new(ErrorCode::InvalidInput, "结束行号不能小于起始行号"));
    }
    const MAX_LINES_PER_CALL: u64 = 5_000;
    let safe_end = start_line + (end_line - start_line).min(MAX_LINES_PER_CALL - 1);

    tauri::async_runtime::spawn_blocking(move || {
        let file = open_file(&path)?;
        let reader = BufReader::new(file);
        let mut out = Vec::new();
        let mut line_no = 0u64;
        for line in reader.lines() {
            let text = line.map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取日志行失败").with_cause(e.to_string())
            })?;
            line_no += 1;
            if line_no < start_line {
                continue;
            }
            if line_no > safe_end {
                break;
            }
            out.push(LogLine {
                line_no,
                text: text.trim_end_matches('\r').to_string(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, "本地日志读取任务失败").with_cause(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_tail_initial(
    path: String,
    n_lines: u32,
    total_lines_hint: Option<f64>,
) -> Result<Vec<LogLine>, OmniError> {
    const MAX_N: u32 = 5_000;
    let n = n_lines.min(MAX_N).max(1) as usize;
    let total_hint = total_lines_hint.map(|v| v.max(0.0) as u64);

    tauri::async_runtime::spawn_blocking(move || {
        let file = open_file(&path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        // 从末尾读一块再切行（最多读 8MB）
        const MAX_BYTES: u64 = 8 * 1024 * 1024;
        let read_from = size.saturating_sub(MAX_BYTES);
        let mut file = file;
        file.seek(SeekFrom::Start(read_from)).map_err(|e| {
            OmniError::new(ErrorCode::Io, "定位日志末尾失败").with_cause(e.to_string())
        })?;
        let mut buf = String::new();
        file.read_to_string(&mut buf).map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取日志末尾失败").with_cause(e.to_string())
        })?;
        // 若非从文件头起读，丢掉第一段残缺行
        let text = if read_from > 0 {
            match buf.find('\n') {
                Some(i) => &buf[i + 1..],
                None => buf.as_str(),
            }
        } else {
            buf.as_str()
        };
        let text = text.replace("\r\n", "\n");
        let trimmed = text.strip_suffix('\n').unwrap_or(&text);
        let mut lines: Vec<&str> = if trimmed.is_empty() {
            Vec::new()
        } else {
            trimmed.split('\n').collect()
        };
        if lines.len() > n {
            lines = lines[lines.len() - n..].to_vec();
        }
        let start_line: u64 = match total_hint {
            Some(hint) => hint
                .saturating_sub(lines.len() as u64)
                .saturating_add(1)
                .max(1),
            None => 1,
        };
        Ok(lines
            .into_iter()
            .enumerate()
            .map(|(i, text)| LogLine {
                line_no: start_line + i as u64,
                text: text.to_string(),
            })
            .collect())
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, "本地日志末尾任务失败").with_cause(e.to_string()))?
}

fn match_line(text: &str, pattern: &str, is_regex: bool, re: &Option<Regex>) -> Option<(usize, usize)> {
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
                // 反搜：返回靠近文件末尾的 max 条，保持行号升序
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
    .map_err(|e| OmniError::new(ErrorCode::Internal, "本地日志搜索任务失败").with_cause(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_tail_start(
    app_handle: AppHandle,
    path: String,
    lines_after: Option<u32>,
) -> Result<LogTailHandle, OmniError> {
    let token = new_local_log_token();
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut map = local_tail_tasks()
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "本地跟踪锁失败"))?;
        map.insert(token.clone(), stop.clone());
    }

    let event_name = format!("local-log-tail-{token}");
    let token_for_task = token.clone();
    let n = lines_after.unwrap_or(0);

    tauri::async_runtime::spawn(async move {
        // 可选：先吐末尾 N 行
        if n > 0 {
            if let Ok(lines) = local_log_tail_initial(path.clone(), n, None).await {
                let texts: Vec<String> = lines.into_iter().map(|l| l.text).collect();
                if !texts.is_empty() {
                    let _ = app_handle.emit(
                        &event_name,
                        LogTailChunk {
                            token: token_for_task.clone(),
                            lines: texts,
                            exit_code: None,
                            error: None,
                        },
                    );
                }
            }
        }

        let mut offset = meta_size(&path).unwrap_or(0);
        let mut carry = String::new();
        while !stop.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let len = meta.len();
            if len < offset {
                // 文件被截断 / rotate
                offset = 0;
                carry.clear();
            }
            if len == offset {
                continue;
            }
            let path_clone = path.clone();
            let read_from = offset;
            let chunk = tauri::async_runtime::spawn_blocking(move || -> Result<(u64, String), OmniError> {
                let mut file = open_file(&path_clone)?;
                file.seek(SeekFrom::Start(read_from)).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "跟踪定位失败").with_cause(e.to_string())
                })?;
                let mut buf = String::new();
                file.read_to_string(&mut buf).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "跟踪读取失败").with_cause(e.to_string())
                })?;
                let new_off = read_from + buf.len() as u64;
                Ok((new_off, buf))
            })
            .await;

            let Ok(Ok((new_off, buf))) = chunk else {
                continue;
            };
            offset = new_off;
            carry.push_str(&buf.replace("\r\n", "\n"));
            let mut lines = Vec::new();
            while let Some(idx) = carry.find('\n') {
                let line = carry[..idx].to_string();
                carry = carry[idx + 1..].to_string();
                lines.push(line);
            }
            if !lines.is_empty() {
                let _ = app_handle.emit(
                    &event_name,
                    LogTailChunk {
                        token: token_for_task.clone(),
                        lines,
                        exit_code: None,
                        error: None,
                    },
                );
            }
        }
    });

    Ok(LogTailHandle { token })
}

#[tauri::command]
#[specta::specta]
pub async fn local_log_tail_stop(token: String) -> Result<(), OmniError> {
    let mut map = local_tail_tasks()
        .lock()
        .map_err(|_| OmniError::new(ErrorCode::Internal, "本地跟踪锁失败"))?;
    if let Some(flag) = map.remove(&token) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
