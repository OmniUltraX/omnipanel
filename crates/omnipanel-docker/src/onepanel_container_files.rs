//! 1Panel 容器文件浏览的终端兜底（面板 API 与绑定 SSH 均不可用时）。
//!
//! 1Panel 各版本容器文件能力：
//! - v2.1+：`POST /api/v2/containers/files/search|content`
//! - v1 / v2.0：无专用 API。首选绑定 SSH 的 `docker exec`，本模块是最后兜底，
//!   经容器终端（PTY）执行 `ls -lan` / `cat` 解析输出。
//!
//! PTY 输出包含命令回显、提示符与 `\n`→`\r\n` 转换（ONLCR），用成对 marker
//! 定界提取净输出，并以 `marker_$rc` 行携带退出码；cols 取 500 避免长行折行
//! 破坏 `ls -lan` 解析。

use futures_util::StreamExt;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use std::time::Duration;

use crate::container_dir_ls::{normalize_container_dir_path, parse_ls_lan_output};
use crate::model::DockerFileEntry;
use crate::onepanel::OnePanelClient;
use crate::onepanel_terminal::create_container_exec;

const BEGIN_MARKER: &str = "__OMNIPANEL_OUT_BEGIN__";
const END_MARKER_PREFIX: &str = "__OMNIPANEL_OUT_END_";
/// PTY 列数取大值，避免长文件名折行破坏行式解析。
const EXEC_COLS: u16 = 500;
const EXEC_ROWS: u16 = 24;
/// 命令输出收集上限，防失控输出占满内存。
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
/// 单次命令收集超时（连接耗时另计）。
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 剥离 ANSI 转义序列：交互式 shell 里 `ls` 可能被 alias 加了颜色码，
/// 不剥离会破坏 `ls -lan` 行式解析。
fn strip_ansi_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            while let Some(n) = chars.next() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

/// 在容器内经 1Panel 终端执行一次性命令，返回 (净输出, 退出码)。
async fn exec_capture(
    client: &OnePanelClient,
    container_id: &str,
    cmd: &str,
) -> OmniResult<(String, i32)> {
    let (session, mut output) =
        create_container_exec(client, container_id, "/bin/sh", EXEC_COLS, EXEC_ROWS).await?;
    let line = format!("echo {BEGIN_MARKER}; {cmd}; rc=$?; echo; echo {END_MARKER_PREFIX}$rc\n");
    let result = match session.write(line.as_bytes()).await {
        Err(e) => Err(e),
        Ok(()) => {
            let deadline = tokio::time::Instant::now() + CAPTURE_TIMEOUT;
            let mut collected: Vec<u8> = Vec::new();
            loop {
                let next = match tokio::time::timeout_at(deadline, output.next()).await {
                    Ok(next) => next,
                    Err(_) => {
                        break Err(OmniError::new(
                            ErrorCode::Timeout,
                            "1Panel 容器命令执行超时",
                        ));
                    }
                };
                match next {
                    Some(Ok(bytes)) => {
                        collected.extend_from_slice(&bytes);
                        if collected.len() > MAX_CAPTURE_BYTES {
                            break Err(OmniError::new(
                                ErrorCode::InvalidInput,
                                "容器命令输出超出大小上限",
                            ));
                        }
                        if let Some(capture) = extract_capture(&collected) {
                            break Ok(capture);
                        }
                    }
                    Some(Err(e)) => break Err(e),
                    None => {
                        break Err(OmniError::new(
                            ErrorCode::Connection,
                            "1Panel 容器终端在命令完成前断开（容器可能已停止）",
                        ));
                    }
                }
            }
        }
    };
    let _ = session.close().await;
    result
}

/// 从 PTY 累积输出中提取 BEGIN/END marker 之间的净输出与退出码。
/// END marker 行形如 `__OMNIPANEL_OUT_END_<rc>`；未收全返回 `None`。
fn extract_capture(bytes: &[u8]) -> Option<(String, i32)> {
    let text = String::from_utf8_lossy(bytes);
    let mut started = false;
    let mut body: Vec<&str> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if !started {
            if line == BEGIN_MARKER {
                started = true;
            }
        } else if let Some(rc_part) = line.strip_prefix(END_MARKER_PREFIX) {
            let rc = rc_part.trim().parse::<i32>().unwrap_or(0);
            return Some((body.join("\n"), rc));
        } else {
            body.push(line);
        }
    }
    None
}

/// 经容器终端 `ls -lan` 列目录（v1 / v2.0 面板回退路径）。
pub async fn list_container_dir_via_exec(
    client: &OnePanelClient,
    container_id: &str,
    path: &str,
) -> OmniResult<Vec<DockerFileEntry>> {
    let path = normalize_container_dir_path(path);
    let cmd = format!("ls -lan -- {}", shell_quote(path));
    let (out, rc) = exec_capture(client, container_id, &cmd).await?;
    if rc != 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "列出容器目录失败")
            .with_cause(out.trim().to_string()));
    }
    Ok(parse_ls_lan_output(&strip_ansi_escapes(&out)))
}

/// 经容器终端 `cat` 读文件（v1 / v2.0 面板回退路径，仅支持文本预览）。
pub async fn read_container_file_via_exec(
    client: &OnePanelClient,
    container_id: &str,
    path: &str,
    max_bytes: i64,
) -> OmniResult<Vec<u8>> {
    let cmd = format!("cat -- {}", shell_quote(path));
    let (out, rc) = exec_capture(client, container_id, &cmd).await?;
    if rc != 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "读取容器文件失败")
            .with_cause(out.trim().to_string()));
    }
    // PTY 的 ONLCR 会把 \n 输出为 \r\n，这里还原。
    let bytes = out.replace("\r\n", "\n").into_bytes();
    if bytes.contains(&0) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "该文件为二进制，暂不支持预览",
        ));
    }
    if max_bytes > 0 && (bytes.len() as i64) > max_bytes {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("文件超过 {} 字节限制", max_bytes),
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_frame(inner: &str) -> Vec<u8> {
        format!("/ # echo {BEGIN_MARKER}; cmd; rc=$?; echo; echo {END_MARKER_PREFIX}$rc\r\n{BEGIN_MARKER}\r\n{inner}\r\n{END_MARKER_PREFIX}0\r\n/ # \r\n").into_bytes()
    }

    #[test]
    fn extracts_output_between_markers_with_echo_and_prompt() {
        let ls = "-rw-r--r-- 1 0 0 12 Jan 1 00:00 a.txt\r\ntotal 8";
        let (out, rc) = extract_capture(&terminal_frame(ls)).unwrap();
        assert_eq!(rc, 0);
        assert_eq!(out, "-rw-r--r-- 1 0 0 12 Jan 1 00:00 a.txt\ntotal 8");
    }

    #[test]
    fn extracts_nonzero_exit_code() {
        let frame = terminal_frame("ls: /nope: No such file or directory");
        let text = String::from_utf8(frame).unwrap();
        let text = text.replace(
            &format!("{END_MARKER_PREFIX}0"),
            &format!("{END_MARKER_PREFIX}2"),
        );
        let (out, rc) = extract_capture(text.as_bytes()).unwrap();
        assert_eq!(rc, 2);
        assert!(out.contains("No such file or directory"));
    }

    #[test]
    fn waits_until_end_marker_present() {
        let partial: Vec<u8> = format!("/ # echo cmd\r\n{BEGIN_MARKER}\r\npartial").into_bytes();
        assert!(extract_capture(&partial).is_none());
    }

    #[test]
    fn strips_ansi_colors_from_ls_output() {
        let colored = "drwxr-xr-x 2 0 0 4096 Jan 1 00:00 \u{1b}[01;34mboot\u{1b}[0m\r\n-rw-r--r-- 1 0 0 12 Jan 1 00:00 a.txt";
        let (out, rc) = extract_capture(&terminal_frame(colored)).unwrap();
        assert_eq!(rc, 0);
        let entries = parse_ls_lan_output(&strip_ansi_escapes(&out));
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.name == "boot" && e.is_dir));
        assert!(entries.iter().any(|e| e.name == "a.txt" && !e.is_dir));
    }
}
