//! tmux control mode（`tmux -CC`）行协议解析。
//!
//! control mode 下 tmux 把所有 pane 输出与状态变更以「一行一条」的文本协议推送过来：
//! 通知行以 `%` 开头，命令响应体夹在 `%begin` / `%end`（或 `%error`）之间且不以 `%` 开头。
//!
//! 本模块只做纯粹的行 → 事件转换，不涉及任何 I/O，便于用单测覆盖协议细节。
//!
//! # 分片边界约束
//!
//! 实测（4 万帧全屏重绘）确认：单个八进制转义序列**不会**被拆到两个 `%output` 行，
//! 因此逐行调用 [`unescape_octal`] 是安全的；但 ESC 控制序列**会**跨行拆分，
//! 所以调用方必须把各行反转义后的字节流**连续拼接**再交给下游 VT/OSC 解析，
//! 不能按行边界重置状态机，否则 OSC 133 之类的序列会被拦腰截断而漏检。

use std::fmt;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub u32);

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($prefix, "{}"), self.0)
            }
        }
    };
}

id_type!(
    /// tmux pane 标识，序列化为 `%0` 形式。
    PaneId,
    "%"
);
id_type!(
    /// tmux window 标识，序列化为 `@0` 形式。
    WindowId,
    "@"
);
id_type!(
    /// tmux session 标识，序列化为 `$0` 形式。
    SessionId,
    "$"
);

/// 一行 control mode 输出解析后的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// `%output %<pane> <data>`，`data` 已完成八进制反转义。
    Output { pane: PaneId, data: Vec<u8> },
    /// `%extended-output %<pane> <age> : <data>`（启用 pause-after 时出现）。
    ExtendedOutput {
        pane: PaneId,
        age: u64,
        data: Vec<u8>,
    },
    /// `%begin <timestamp> <number> <flags>`，命令响应开始。
    Begin(CommandTag),
    /// `%end <timestamp> <number> <flags>`，命令成功结束。
    End(CommandTag),
    /// `%error <timestamp> <number> <flags>`，命令失败结束。
    Error(CommandTag),
    WindowAdd { window: WindowId },
    WindowClose { window: WindowId },
    WindowRenamed { window: WindowId, name: String },
    LayoutChange { window: WindowId, layout: String },
    SessionsChanged,
    SessionChanged { session: SessionId, name: String },
    SessionWindowChanged { session: SessionId, window: WindowId },
    /// pane 输出被暂停（客户端落后于 pause-after 阈值）。
    Pause { pane: PaneId },
    /// pane 输出恢复。
    Continue { pane: PaneId },
    /// `%exit [reason]`，control 连接即将关闭。
    Exit { reason: Option<String> },
    /// 不以 `%` 开头的行：命令响应体，由调用方按 `%begin`/`%end` 区间归集。
    Raw(Vec<u8>),
    /// 未识别或当前无需处理的通知行。对未知通知保持宽容，避免新版本 tmux 引入
    /// 新通知类型时解析器整体失败。
    Ignored,
}

/// `%begin` / `%end` / `%error` 三元组，用于把响应体与发出的命令配对。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandTag {
    pub timestamp: i64,
    pub number: u64,
    pub flags: u64,
}

/// 还原 tmux 的八进制转义。
///
/// tmux 以 `VIS_OCTAL` 风格转义 pane 字节流：不可打印字节写作 `\ooo` 三位八进制
/// （ESC→`\033`、BEL→`\007`、CR→`\015`、LF→`\012`），反斜杠自身写作 `\134`，
/// 其余字节（含合法 UTF-8 多字节序列）原样输出。
///
/// 实现为单遍扫描，绝不对产物二次解析——否则 `\134033`（字面量 `\033` 六个字符）
/// 会被错误还原成 ESC 字节。
pub fn unescape_octal(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        if src[i] == b'\\' && i + 3 < src.len() {
            let digits = &src[i + 1..i + 4];
            if digits.iter().all(|b| (b'0'..=b'7').contains(b)) {
                let value = digits
                    .iter()
                    .fold(0u32, |acc, b| acc * 8 + u32::from(b - b'0'));
                // 三位八进制最大 0o777 = 511，超出单字节的一律按字面量处理
                if value <= u32::from(u8::MAX) {
                    out.push(value as u8);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(src[i]);
        i += 1;
    }
    out
}

/// 按首个分隔符切成两段，右段可能为空。
fn split_once(line: &[u8], sep: u8) -> (&[u8], &[u8]) {
    match line.iter().position(|b| *b == sep) {
        Some(idx) => (&line[..idx], &line[idx + 1..]),
        None => (line, &[]),
    }
}

/// 解析 `%0` / `@1` / `$2` 形式的标识符。
fn parse_id(token: &[u8], prefix: u8) -> Option<u32> {
    let rest = token.strip_prefix(&[prefix])?;
    if rest.is_empty() {
        return None;
    }
    std::str::from_utf8(rest).ok()?.parse().ok()
}

fn parse_tag(rest: &[u8]) -> Option<CommandTag> {
    let text = std::str::from_utf8(rest).ok()?;
    let mut parts = text.split_whitespace();
    Some(CommandTag {
        timestamp: parts.next()?.parse().ok()?,
        number: parts.next()?.parse().ok()?,
        flags: parts.next().unwrap_or("0").parse().unwrap_or(0),
    })
}

fn to_string(rest: &[u8]) -> String {
    String::from_utf8_lossy(rest).into_owned()
}

/// 解析单行 control mode 输出。
///
/// 传入的 `line` 不应包含行尾的 `\r\n`。
pub fn parse_line(line: &[u8]) -> ControlEvent {
    if !line.starts_with(b"%") {
        return ControlEvent::Raw(line.to_vec());
    }

    let (tag, rest) = split_once(line, b' ');
    match tag {
        b"%output" => {
            let (pane, data) = split_once(rest, b' ');
            match parse_id(pane, b'%') {
                Some(id) => ControlEvent::Output {
                    pane: PaneId(id),
                    data: unescape_octal(data),
                },
                None => ControlEvent::Ignored,
            }
        }
        b"%extended-output" => {
            // 形如：%extended-output %0 <age> : <data>
            let (pane, tail) = split_once(rest, b' ');
            let (age, tail) = split_once(tail, b' ');
            let data = match tail.strip_prefix(b": ") {
                Some(d) => d,
                // 分隔符缺失时退化为整段当数据，宁可多带几个字节也不丢输出
                None => tail.strip_prefix(b":").unwrap_or(tail),
            };
            match parse_id(pane, b'%') {
                Some(id) => ControlEvent::ExtendedOutput {
                    pane: PaneId(id),
                    age: std::str::from_utf8(age)
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0),
                    data: unescape_octal(data),
                },
                None => ControlEvent::Ignored,
            }
        }
        b"%begin" => parse_tag(rest).map_or(ControlEvent::Ignored, ControlEvent::Begin),
        b"%end" => parse_tag(rest).map_or(ControlEvent::Ignored, ControlEvent::End),
        b"%error" => parse_tag(rest).map_or(ControlEvent::Ignored, ControlEvent::Error),
        b"%window-add" => parse_id(rest, b'@').map_or(ControlEvent::Ignored, |id| {
            ControlEvent::WindowAdd {
                window: WindowId(id),
            }
        }),
        b"%window-close" | b"%unlinked-window-close" => {
            parse_id(rest, b'@').map_or(ControlEvent::Ignored, |id| ControlEvent::WindowClose {
                window: WindowId(id),
            })
        }
        b"%window-renamed" | b"%unlinked-window-renamed" => {
            let (window, name) = split_once(rest, b' ');
            parse_id(window, b'@').map_or(ControlEvent::Ignored, |id| {
                ControlEvent::WindowRenamed {
                    window: WindowId(id),
                    name: to_string(name),
                }
            })
        }
        b"%layout-change" => {
            let (window, layout) = split_once(rest, b' ');
            parse_id(window, b'@').map_or(ControlEvent::Ignored, |id| {
                // 后续还有 visible-layout 与 flags，只取首个布局串
                let (first, _) = split_once(layout, b' ');
                ControlEvent::LayoutChange {
                    window: WindowId(id),
                    layout: to_string(first),
                }
            })
        }
        b"%sessions-changed" => ControlEvent::SessionsChanged,
        b"%session-changed" => {
            let (session, name) = split_once(rest, b' ');
            parse_id(session, b'$').map_or(ControlEvent::Ignored, |id| {
                ControlEvent::SessionChanged {
                    session: SessionId(id),
                    name: to_string(name),
                }
            })
        }
        b"%session-window-changed" => {
            let (session, window) = split_once(rest, b' ');
            match (parse_id(session, b'$'), parse_id(window, b'@')) {
                (Some(s), Some(w)) => ControlEvent::SessionWindowChanged {
                    session: SessionId(s),
                    window: WindowId(w),
                },
                _ => ControlEvent::Ignored,
            }
        }
        b"%pause" => parse_id(rest, b'%')
            .map_or(ControlEvent::Ignored, |id| ControlEvent::Pause {
                pane: PaneId(id),
            }),
        b"%continue" => parse_id(rest, b'%')
            .map_or(ControlEvent::Ignored, |id| ControlEvent::Continue {
                pane: PaneId(id),
            }),
        b"%exit" => ControlEvent::Exit {
            reason: if rest.is_empty() {
                None
            } else {
                Some(to_string(rest))
            },
        },
        _ => ControlEvent::Ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用：模拟 tmux 的 VIS_OCTAL 转义，用于往返一致性验证。
    fn escape_octal(src: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(src.len());
        for &b in src {
            if b == b'\\' || !(0x20..0x7f).contains(&b) {
                out.extend_from_slice(format!("\\{:03o}", b).as_bytes());
            } else {
                out.push(b);
            }
        }
        out
    }

    #[test]
    fn unescapes_common_control_bytes() {
        assert_eq!(unescape_octal(b"\\033[31m"), b"\x1b[31m");
        assert_eq!(unescape_octal(b"a\\015\\012b"), b"a\r\nb");
        assert_eq!(unescape_octal(b"\\007"), b"\x07");
    }

    #[test]
    fn backslash_itself_is_not_double_unescaped() {
        // `\134033` 是字面量 `\033`（六个字符），绝不能还原成 ESC 字节
        assert_eq!(unescape_octal(b"\\134033"), b"\\033");
        assert_eq!(unescape_octal(b"\\134"), b"\\");
    }

    #[test]
    fn leaves_incomplete_or_invalid_escapes_untouched() {
        assert_eq!(unescape_octal(b"\\03"), b"\\03");
        assert_eq!(unescape_octal(b"\\"), b"\\");
        assert_eq!(unescape_octal(b"\\089"), b"\\089");
        assert_eq!(unescape_octal(b"\\777"), b"\\777");
    }

    #[test]
    fn passes_through_utf8_bytes() {
        let text = "中文 émoji 🚀".as_bytes();
        assert_eq!(unescape_octal(text), text);
    }

    #[test]
    fn roundtrip_holds_for_pseudo_random_byte_sequences() {
        // 线性同余伪随机，避免为属性测试引入额外依赖
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        for len in 0..256usize {
            let mut input = Vec::with_capacity(len);
            for _ in 0..len {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                input.push((state >> 33) as u8);
            }
            let escaped = escape_octal(&input);
            assert_eq!(
                unescape_octal(&escaped),
                input,
                "往返失败，长度 {len}，输入 {input:?}"
            );
        }
    }

    #[test]
    fn roundtrip_holds_for_all_single_bytes() {
        for b in 0u8..=255 {
            assert_eq!(unescape_octal(&escape_octal(&[b])), vec![b], "字节 {b}");
        }
    }

    #[test]
    fn parses_output_line() {
        let ev = parse_line(b"%output %3 hello\\015\\012");
        assert_eq!(
            ev,
            ControlEvent::Output {
                pane: PaneId(3),
                data: b"hello\r\n".to_vec()
            }
        );
    }

    #[test]
    fn parses_output_containing_spaces() {
        let ev = parse_line(b"%output %0 a b  c");
        match ev {
            ControlEvent::Output { pane, data } => {
                assert_eq!(pane, PaneId(0));
                assert_eq!(data, b"a b  c");
            }
            other => panic!("非预期事件: {other:?}"),
        }
    }

    #[test]
    fn parses_command_tags() {
        assert_eq!(
            parse_line(b"%begin 1785484406 272 0"),
            ControlEvent::Begin(CommandTag {
                timestamp: 1785484406,
                number: 272,
                flags: 0
            })
        );
        assert_eq!(
            parse_line(b"%end 1785484406 272 1"),
            ControlEvent::End(CommandTag {
                timestamp: 1785484406,
                number: 272,
                flags: 1
            })
        );
        assert!(matches!(
            parse_line(b"%error 1785484406 273 1"),
            ControlEvent::Error(_)
        ));
    }

    #[test]
    fn parses_window_and_session_notifications() {
        assert_eq!(
            parse_line(b"%window-add @1"),
            ControlEvent::WindowAdd {
                window: WindowId(1)
            }
        );
        assert_eq!(
            parse_line(b"%window-close @2"),
            ControlEvent::WindowClose {
                window: WindowId(2)
            }
        );
        assert_eq!(
            parse_line(b"%window-renamed @0 my shell"),
            ControlEvent::WindowRenamed {
                window: WindowId(0),
                name: "my shell".to_string()
            }
        );
        assert_eq!(parse_line(b"%sessions-changed"), ControlEvent::SessionsChanged);
        assert_eq!(
            parse_line(b"%session-changed $0 0"),
            ControlEvent::SessionChanged {
                session: SessionId(0),
                name: "0".to_string()
            }
        );
        assert_eq!(
            parse_line(b"%session-window-changed $0 @1"),
            ControlEvent::SessionWindowChanged {
                session: SessionId(0),
                window: WindowId(1)
            }
        );
    }

    #[test]
    fn parses_layout_change_taking_first_layout_only() {
        assert_eq!(
            parse_line(b"%layout-change @0 aafd,120x40,0,0,0 aafd,120x40,0,0,0 *"),
            ControlEvent::LayoutChange {
                window: WindowId(0),
                layout: "aafd,120x40,0,0,0".to_string()
            }
        );
    }

    #[test]
    fn parses_exit_with_and_without_reason() {
        assert_eq!(parse_line(b"%exit"), ControlEvent::Exit { reason: None });
        assert_eq!(
            parse_line(b"%exit server exited unexpectedly"),
            ControlEvent::Exit {
                reason: Some("server exited unexpectedly".to_string())
            }
        );
    }

    #[test]
    fn parses_pause_and_continue() {
        assert_eq!(
            parse_line(b"%pause %1"),
            ControlEvent::Pause { pane: PaneId(1) }
        );
        assert_eq!(
            parse_line(b"%continue %1"),
            ControlEvent::Continue { pane: PaneId(1) }
        );
    }

    #[test]
    fn parses_extended_output() {
        assert_eq!(
            parse_line(b"%extended-output %2 137 : hi\\012"),
            ControlEvent::ExtendedOutput {
                pane: PaneId(2),
                age: 137,
                data: b"hi\n".to_vec()
            }
        );
    }

    #[test]
    fn treats_non_percent_lines_as_response_body() {
        assert_eq!(
            parse_line(b"@0 120x40"),
            ControlEvent::Raw(b"@0 120x40".to_vec())
        );
        assert_eq!(parse_line(b""), ControlEvent::Raw(Vec::new()));
    }

    #[test]
    fn unknown_notifications_are_ignored_not_errors() {
        assert_eq!(parse_line(b"%subscription-changed foo"), ControlEvent::Ignored);
        assert_eq!(parse_line(b"%client-detached client-1"), ControlEvent::Ignored);
        assert_eq!(parse_line(b"%some-future-notification a b c"), ControlEvent::Ignored);
    }

    #[test]
    fn malformed_ids_are_ignored() {
        assert_eq!(parse_line(b"%output bad data"), ControlEvent::Ignored);
        assert_eq!(parse_line(b"%window-add @"), ControlEvent::Ignored);
        assert_eq!(parse_line(b"%window-add xyz"), ControlEvent::Ignored);
    }

    #[test]
    fn id_types_display_with_tmux_prefixes() {
        assert_eq!(PaneId(0).to_string(), "%0");
        assert_eq!(WindowId(12).to_string(), "@12");
        assert_eq!(SessionId(3).to_string(), "$3");
    }

    // --- OSC 回归：固定用例取自真实 tmux -CC 抓包 ---

    #[test]
    fn preserves_osc_133_sequences_bel_terminated() {
        for (raw, want) in [
            (
                b"%output %0 \\033]133;A\\007".as_slice(),
                b"\x1b]133;A\x07".as_slice(),
            ),
            (b"%output %0 \\033]133;B\\007", b"\x1b]133;B\x07"),
            (b"%output %0 \\033]133;C\\007", b"\x1b]133;C\x07"),
            (b"%output %0 \\033]133;D;42\\007", b"\x1b]133;D;42\x07"),
        ] {
            match parse_line(raw) {
                ControlEvent::Output { data, .. } => assert_eq!(data, want),
                other => panic!("非预期事件: {other:?}"),
            }
        }
    }

    #[test]
    fn preserves_osc_sequences_st_terminated() {
        // ST 结尾形式：ESC \ ，其中反斜杠自身被转义为 \134
        match parse_line(b"%output %0 \\033]133;D;0\\033\\134") {
            ControlEvent::Output { data, .. } => assert_eq!(data, b"\x1b]133;D;0\x1b\\"),
            other => panic!("非预期事件: {other:?}"),
        }
    }

    #[test]
    fn preserves_other_osc_families() {
        for (raw, want) in [
            (
                b"%output %0 \\033]1337;CurrentDir=/root\\007".as_slice(),
                b"\x1b]1337;CurrentDir=/root\x07".as_slice(),
            ),
            (
                b"%output %0 \\033]7;file://host/tmp\\007",
                b"\x1b]7;file://host/tmp\x07",
            ),
            (b"%output %0 \\033]0;title\\007", b"\x1b]0;title\x07"),
            (
                b"%output %0 \\033]633;E;cmd\\007",
                b"\x1b]633;E;cmd\x07",
            ),
        ] {
            match parse_line(raw) {
                ControlEvent::Output { data, .. } => assert_eq!(data, want),
                other => panic!("非预期事件: {other:?}"),
            }
        }
    }

    #[test]
    fn reproduces_captured_shell_prompt_line() {
        // 抓包原文：bash 回显 + bracketed paste 关闭 + 提示符
        let line = b"%output %0 stty size\\015\\012\\033[?2004l\\015";
        match parse_line(line) {
            ControlEvent::Output { pane, data } => {
                assert_eq!(pane, PaneId(0));
                assert_eq!(data, b"stty size\r\n\x1b[?2004l\r");
            }
            other => panic!("非预期事件: {other:?}"),
        }
    }

    #[test]
    fn reproduces_captured_color_output_line() {
        let line = b"%output %0 \\033[31mCOLORMARK\\033[0m\\015\\012";
        match parse_line(line) {
            ControlEvent::Output { data, .. } => {
                assert_eq!(data, b"\x1b[31mCOLORMARK\x1b[0m\r\n");
            }
            other => panic!("非预期事件: {other:?}"),
        }
    }

    #[test]
    fn concatenating_split_sequences_restores_original() {
        // 实测中 ESC 序列会跨 %output 行拆分，验证拼接后可完整还原
        let mut stream = Vec::new();
        for line in [
            b"%output %0 \\033[3".as_slice(),
            b"%output %0 1mRED\\033".as_slice(),
            b"%output %0 [0m".as_slice(),
        ] {
            match parse_line(line) {
                ControlEvent::Output { data, .. } => stream.extend_from_slice(&data),
                other => panic!("非预期事件: {other:?}"),
            }
        }
        assert_eq!(stream, b"\x1b[31mRED\x1b[0m");
    }
}
