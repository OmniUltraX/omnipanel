//! 本地 / SFTP 日志反搜（自桌面端移植）。

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::log_tail::{LogSearchHit, LogSearchOptions};
use regex::Regex;

use crate::log_tail::resolve_log_session_for_media;
use crate::state::ServerState;

fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
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
    } else if let Some(idx) = text.find(pattern) {
        Some((idx, idx + pattern.len()))
    } else {
        None
    }
}

fn open_file(path: &str) -> OmniResult<File> {
    File::open(path).map_err(|e| {
        OmniError::new(ErrorCode::Io, "打开日志文件失败").with_cause(e.to_string())
    })
}

pub async fn local_log_search(
    path: String,
    pattern: String,
    options: Option<LogSearchOptions>,
) -> OmniResult<Vec<LogSearchHit>> {
    tokio::task::spawn_blocking(move || local_log_search_sync(path, pattern, options))
        .await
        .map_err(|e| OmniError::internal(format!("本地日志搜索任务失败: {e}")))?
}

fn local_log_search_sync(
    path: String,
    pattern: String,
    options: Option<LogSearchOptions>,
) -> OmniResult<Vec<LogSearchHit>> {
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

    let re = if is_regex {
        Some(
            Regex::new(&pattern)
                .map_err(|e| OmniError::invalid_input("无效正则").with_cause(e.to_string()))?,
        )
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
}

pub async fn sftp_log_search(
    state: &ServerState,
    id: String,
    path: String,
    pattern: String,
    options: Option<LogSearchOptions>,
) -> OmniResult<Vec<LogSearchHit>> {
    const DEFAULT_MAX: u32 = 200;
    const ABSOLUTE_MAX: u32 = 5_000;
    let opts = options.unwrap_or_default();
    let is_regex = opts.is_regex.unwrap_or(false);
    let max = opts.max_results.unwrap_or(DEFAULT_MAX).min(ABSOLUTE_MAX);
    let reverse = opts.reverse.unwrap_or(false);
    let before = opts.before_line.filter(|&n| n > 1);
    let after = opts.after_line.filter(|&n| n > 0);
    let total_hint = opts.total_lines_hint.filter(|&n| n > 0);
    let skip = opts.skip_matches.unwrap_or(0);
    let context_before = opts.context_before;
    let context_after = opts.context_after;

    let pattern_quoted = shell_quote_single(&pattern);
    let path_q = shell_quote_single(&path);
    let grep_flags = if is_regex { "-E" } else { "-F" };
    let context_args = if reverse {
        String::new()
    } else {
        let mut s = String::new();
        if let Some(b) = context_before {
            s.push_str(&format!(" -B {b}"));
        }
        if let Some(a) = context_after {
            s.push_str(&format!(" -A {a}"));
        }
        s
    };

    let take = skip.saturating_add(max).max(1);

    let (cmd, line_base, invert_relative) = if reverse {
        if let Some(total) = total_hint {
            let cmd = format!(
                "tac {path_q} | grep -n --color=never --line-buffered {grep_flags}{context_args} -m {take} {pattern_quoted}"
            );
            (cmd, Some(total), true)
        } else {
            let cmd = format!(
                "grep -n --color=never --line-buffered {grep_flags}{context_args} {pattern_quoted} {path_q} | tail -n {take}"
            );
            (cmd, None, false)
        }
    } else if let Some(after_l) = after {
        if skip > 0 {
            let cmd = format!(
                "grep -n --color=never --line-buffered {grep_flags}{context_args} -m {take} {pattern_quoted} {path_q}"
            );
            (cmd, None, false)
        } else {
            let start = after_l + 1;
            let cmd = format!(
                "tail -n +{start} {path_q} | grep -n --color=never --line-buffered {grep_flags}{context_args} -m {max} {pattern_quoted}"
            );
            (cmd, Some(after_l), false)
        }
    } else {
        let cmd = format!(
            "grep -n --color=never --line-buffered {grep_flags}{context_args} -m {take} {pattern_quoted} {path_q}"
        );
        (cmd, None, false)
    };

    let session: Arc<omnipanel_ssh::SshSession> = resolve_log_session_for_media(state, &id).await?;
    let output = session.exec_capture(&cmd).await?;
    if output.exit_code != 0 && output.stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut hits = Vec::new();
    for line in output.stdout.lines() {
        let Some((line_part, content)) = line.split_once(':') else {
            continue;
        };
        let Ok(mut line_no) = line_part.parse::<u64>() else {
            continue;
        };
        if invert_relative {
            if let Some(total) = line_base {
                line_no = total.saturating_sub(line_no).saturating_add(1);
            }
        } else if let Some(base) = line_base {
            line_no = base.saturating_add(line_no);
        }
        let (ms, me) = match_line(content, &pattern, is_regex, &None).unwrap_or((0, 0));
        hits.push(LogSearchHit {
            line_no,
            content: content.to_string(),
            match_start: Some(ms),
            match_end: Some(me),
        });
    }

    let skip_usize = skip as usize;
    let max_usize = max as usize;
    if skip_usize > 0 && hits.len() > skip_usize {
        hits = hits.into_iter().skip(skip_usize).take(max_usize).collect();
    } else if hits.len() > max_usize {
        hits.truncate(max_usize);
    }
    Ok(hits)
}
