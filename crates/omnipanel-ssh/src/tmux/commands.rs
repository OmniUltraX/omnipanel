//! tmux 命令串构造。
//!
//! 全部实现为纯函数，便于单测断言生成结果——尤其是 `window-size` 的作用域，
//! 一旦误用 `-g` 会导致 tmux 3.4+ 服务端崩溃、该主机全部会话丢失。

use serde::Serialize;

use super::parser::{PaneId, WindowId};

/// 远端 tmux 会话概要，用于 `/server` 的会话治理视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSessionInfo {
    pub name: String,
    pub windows: u32,
    /// 创建时间（Unix 秒）。
    #[specta(type = f64)]
    pub created: i64,
    pub attached: bool,
    /// 是否由 OmniPanel 创建（按会话名前缀判定）。
    pub managed: bool,
}

/// 解析 [`list_sessions`] 输出的一行。
///
/// 与 control mode 无关，走 exec 通道直接执行 `tmux list-sessions` 时同样适用。
pub fn parse_session_line(line: &[u8]) -> Option<TmuxSessionInfo> {
    let text = String::from_utf8_lossy(line);
    let mut parts = text.split('\t');
    let name = parts.next()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(TmuxSessionInfo {
        managed: is_omnipanel_session(&name),
        name,
        windows: parts.next().and_then(|v| v.trim().parse().ok()).unwrap_or(0),
        created: parts.next().and_then(|v| v.trim().parse().ok()).unwrap_or(0),
        attached: parts.next().map(|v| v.trim() != "0").unwrap_or(false),
    })
}

/// OmniPanel 创建的会话统一前缀，便于识别与批量治理僵尸会话。
pub const SESSION_PREFIX: &str = "omnipanel-";

/// 单条 `send-keys` 最多携带的原始字节数。
///
/// 每字节展开为 3 个字符（两位十六进制 + 分隔空格），取 1024 使单条命令行
/// 稳定在 3KB 量级，远低于常见的行长上限，同时避免粘贴大段文本时命令过多。
pub const MAX_SEND_KEYS_CHUNK: usize = 1024;

/// 远端 tmux 会话默认保留的历史行数上限。
///
/// detached 会话仍会持续解析输出并维护 grid，上限过大时远端内存占用不可控。
pub const DEFAULT_HISTORY_LIMIT: u32 = 5000;

/// 把任意文本规整为合法的 tmux 会话名。
///
/// tmux 会话名不能包含 `.` 与 `:`（后者是 `session:window.pane` 目标语法的分隔符），
/// 同时剔除引号、反斜杠与会引发 shell 展开的字符，避免拼接命令时产生注入。
pub fn sanitize_session_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '.' | ':' | ' ' | '\t' | '"' | '\'' | '\\' | '$' | '`' | '(' | ')' | ';' | '&'
            | '|' | '<' | '>' | '*' | '?' | '[' | ']' | '{' | '}' | '!' | '#' | '~' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 由工作区标识生成带前缀的会话名。
pub fn session_name_for_workspace(workspace: &str) -> String {
    format!("{SESSION_PREFIX}{}", sanitize_session_name(workspace))
}

/// 是否是 OmniPanel 创建的会话。
pub fn is_omnipanel_session(name: &str) -> bool {
    name.starts_with(SESSION_PREFIX)
}

/// 用单引号做 POSIX shell 引用，内部单引号按 `'\''` 处理。
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// tmux 命令参数的双引号引用。
fn tmux_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', r"\\").replace('"', "\\\""))
}

/// 远端用于建立 control 连接的 shell 命令。
///
/// `new-session -A` 语义为「存在则 attach，不存在则新建」，这正是跨进程复用
/// 已有会话所需；`-D` 使其他已 attach 的客户端被顶下线，避免尺寸相互干扰。
pub fn control_mode_command(session_name: &str, cols: u16, rows: u16) -> String {
    format!(
        "tmux -CC new-session -A -D -s {} -x {cols} -y {rows}",
        shell_quote(session_name)
    )
}

/// 探测远端 tmux 版本的命令。
pub fn version_probe_command() -> &'static str {
    "tmux -V"
}

/// 新建 window，并回显 `<window_id> <pane_id>` 便于登记映射。
pub fn new_window(shell_command: Option<&str>) -> String {
    let mut cmd = String::from("new-window -d -P -F \"#{window_id} #{pane_id}\"");
    if let Some(sh) = shell_command {
        cmd.push(' ');
        cmd.push_str(&tmux_quote(sh));
    }
    cmd
}

/// 让指定 window 使用手动尺寸。
///
/// **必须**使用 `-w` 作用域。实测 `set-option -g window-size manual` 生效期间
/// 执行 `new-window` 会使 tmux 3.4 / 3.6 服务端崩溃，该主机上全部会话一并丢失。
pub fn set_window_size_manual(window: WindowId) -> String {
    format!("set-option -w -t {window} window-size manual")
}

/// 设置会话历史行数上限。
pub fn set_history_limit(limit: u32) -> String {
    format!("set-option -g history-limit {limit}")
}

/// 调整单个 window 的尺寸。
pub fn resize_window(window: WindowId, cols: u16, rows: u16) -> String {
    format!("resize-window -t {window} -x {cols} -y {rows}")
}

pub fn kill_window(window: WindowId) -> String {
    format!("kill-window -t {window}")
}

pub fn kill_session(session_name: &str) -> String {
    format!("kill-session -t {}", tmux_quote(session_name))
}

/// 列出全部会话，字段以 `\t` 分隔，供 [`parse_session_line`] 逐行解析。
pub fn list_sessions() -> String {
    "list-sessions -F \"#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\"".to_string()
}

/// 走 exec 通道（而非 control mode）列出会话的 shell 命令。
///
/// 无会话时 tmux 以非 0 退出并打印 "no server running"，调用方按空列表处理。
pub fn list_sessions_shell() -> String {
    format!("tmux {}", list_sessions())
}

/// 走 exec 通道终止会话的 shell 命令。
pub fn kill_session_shell(session_name: &str) -> String {
    format!("tmux kill-session -t {}", shell_quote(session_name))
}

/// 列出会话内的 window 与其 pane，用于重连后重建映射。
pub fn list_windows(session_name: &str) -> String {
    format!(
        "list-panes -s -t {} -F \"#{{window_id}}\t#{{pane_id}}\t#{{window_name}}\"",
        tmux_quote(session_name)
    )
}

/// 抓取 pane 的可见内容与历史，用于重开 Tab 时恢复屏幕。
///
/// `-e` 保留 SGR 等转义序列，否则恢复出来的内容会丢失颜色；
/// `-J` 把因宽度折行的逻辑行重新拼接，避免恢复后出现硬换行。
pub fn capture_pane(pane: PaneId, history_lines: u32) -> String {
    format!(
        "capture-pane -p -e -J -t {pane} -S -{history_lines}",
        history_lines = history_lines
    )
}

/// 把字节流转换为若干条 `send-keys -H` 命令。
///
/// 使用十六进制字面量而非文本，可完整传递任意字节（含控制字符、非 UTF-8 序列），
/// 无需关心 tmux 的键名解析与引号规则。
pub fn send_keys_batches(pane: PaneId, data: &[u8]) -> Vec<String> {
    if data.is_empty() {
        return Vec::new();
    }
    data.chunks(MAX_SEND_KEYS_CHUNK)
        .map(|chunk| {
            let mut cmd = format!("send-keys -t {pane} -H");
            for b in chunk {
                cmd.push(' ');
                cmd.push_str(&format!("{b:02x}"));
            }
            cmd
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_size_is_never_set_globally() {
        // 回归防线：`-g` 会导致 tmux 3.4+ 服务端崩溃并丢失全部会话
        let cmd = set_window_size_manual(WindowId(3));
        assert_eq!(cmd, "set-option -w -t @3 window-size manual");
        assert!(!cmd.contains("-g"), "window-size 严禁使用 global 作用域");
    }

    #[test]
    fn resize_targets_window_not_pane() {
        assert_eq!(
            resize_window(WindowId(2), 120, 40),
            "resize-window -t @2 -x 120 -y 40"
        );
    }

    #[test]
    fn send_keys_encodes_arbitrary_bytes() {
        let cmds = send_keys_batches(PaneId(0), b"ls\r");
        assert_eq!(cmds, vec!["send-keys -t %0 -H 6c 73 0d".to_string()]);
    }

    #[test]
    fn send_keys_handles_bytes_that_break_quoting() {
        // 引号、反斜杠、NUL、高位字节都必须原样编码
        let data = [0x00, b'"', b'\'', b'\\', b'$', 0xff, 0x1b];
        let cmds = send_keys_batches(PaneId(1), &data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0], "send-keys -t %1 -H 00 22 27 5c 24 ff 1b");
        assert!(!cmds[0].contains('"'));
        assert!(!cmds[0].contains('\\'));
    }

    #[test]
    fn send_keys_returns_nothing_for_empty_input() {
        assert!(send_keys_batches(PaneId(0), b"").is_empty());
    }

    #[test]
    fn send_keys_splits_large_input_and_preserves_order() {
        let data: Vec<u8> = (0..(MAX_SEND_KEYS_CHUNK * 2 + 5))
            .map(|i| (i % 256) as u8)
            .collect();
        let cmds = send_keys_batches(PaneId(0), &data);
        assert_eq!(cmds.len(), 3);

        // 把命令还原回字节流，必须与原输入逐字节一致
        let mut restored = Vec::new();
        for cmd in &cmds {
            let hex = cmd.strip_prefix("send-keys -t %0 -H ").unwrap();
            for token in hex.split(' ') {
                restored.push(u8::from_str_radix(token, 16).unwrap());
            }
        }
        assert_eq!(restored, data);
    }

    #[test]
    fn session_names_strip_tmux_reserved_characters() {
        // `.` 与 `:` 是 tmux 目标语法的分隔符，必须替换
        assert_eq!(sanitize_session_name("my.project:dev"), "my_project_dev");
        assert_eq!(sanitize_session_name("a b"), "a_b");
    }

    #[test]
    fn session_names_strip_shell_metacharacters() {
        assert_eq!(sanitize_session_name("evil$(rm -rf /)"), "evil__rm_-rf_/");
        assert_eq!(sanitize_session_name("a`b`c"), "a_b_c");
        assert_eq!(sanitize_session_name("a\"b'c\\d"), "a_b_c_d");
    }

    #[test]
    fn session_names_fall_back_when_empty() {
        assert_eq!(sanitize_session_name(""), "default");
        assert_eq!(sanitize_session_name("..."), "default");
    }

    #[test]
    fn workspace_sessions_carry_recognizable_prefix() {
        let name = session_name_for_workspace("proj.a");
        assert_eq!(name, "omnipanel-proj_a");
        assert!(is_omnipanel_session(&name));
        assert!(!is_omnipanel_session("some-other-session"));
    }

    #[test]
    fn control_command_attaches_or_creates() {
        let cmd = control_mode_command("omnipanel-ws", 120, 40);
        assert_eq!(
            cmd,
            "tmux -CC new-session -A -D -s 'omnipanel-ws' -x 120 -y 40"
        );
        assert!(cmd.contains("-A"), "必须支持 attach-or-create");
    }

    #[test]
    fn control_command_quotes_session_name() {
        let cmd = control_mode_command("it's", 80, 24);
        assert!(cmd.contains(r"'it'\''s'"), "单引号需按 POSIX 规则转义: {cmd}");
    }

    #[test]
    fn new_window_reports_ids() {
        assert_eq!(
            new_window(None),
            "new-window -d -P -F \"#{window_id} #{pane_id}\""
        );
        assert_eq!(
            new_window(Some("bash -l")),
            "new-window -d -P -F \"#{window_id} #{pane_id}\" \"bash -l\""
        );
    }

    #[test]
    fn capture_pane_keeps_escape_sequences() {
        let cmd = capture_pane(PaneId(4), 2000);
        assert_eq!(cmd, "capture-pane -p -e -J -t %4 -S -2000");
        assert!(cmd.contains("-e"), "必须保留 SGR 序列，否则恢复内容会丢失颜色");
    }

    #[test]
    fn kill_commands_target_correct_scope() {
        assert_eq!(kill_window(WindowId(1)), "kill-window -t @1");
        assert_eq!(kill_session("omnipanel-ws"), "kill-session -t \"omnipanel-ws\"");
    }

    #[test]
    fn list_commands_use_tab_separated_format() {
        assert!(list_sessions().contains("#{session_name}"));
        assert!(list_sessions().contains('\t'));
        assert!(list_windows("ws").contains("#{window_id}"));
    }
}
