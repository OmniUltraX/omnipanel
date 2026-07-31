//! 远端 tmux 能力探测与版本判定。
//!
//! 支持下限定为 **3.2**，依据是 3.0a 上 `resize-window` 只更新 `list-windows`
//! 报告的尺寸、pane 内进程通过 `stty size` 看到的仍是旧值（即未真正 resize，
//! TUI 会渲染错位）。3.2a / 3.4 / 3.6 实测全链路正常。
//!
//! 本模块只做纯解析与判定，实际的 `tmux -V` 执行由调用方完成，便于单测覆盖。

use std::fmt;

/// tmux 版本号，形如 `3.2a` 拆为 major=3、minor=2、suffix=Some('a')。
///
/// 字段顺序即比较优先级；`Option<char>` 的 `None < Some(_)` 恰好满足
/// `3.2 < 3.2a` 这一 tmux 版本序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TmuxVersion {
    pub major: u32,
    pub minor: u32,
    pub suffix: Option<char>,
}

/// 受支持的最低版本。
pub const MIN_SUPPORTED: TmuxVersion = TmuxVersion {
    major: 3,
    minor: 2,
    suffix: None,
};

impl TmuxVersion {
    pub const fn new(major: u32, minor: u32) -> Self {
        Self {
            major,
            minor,
            suffix: None,
        }
    }

    /// 是否达到受支持下限。
    pub fn is_supported(&self) -> bool {
        *self >= MIN_SUPPORTED
    }
}

impl fmt::Display for TmuxVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)?;
        if let Some(s) = self.suffix {
            write!(f, "{s}")?;
        }
        Ok(())
    }
}

/// 远端 tmux 探测结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxCapability {
    /// 版本满足要求，可走 control mode。
    Supported(TmuxVersion),
    /// 装了 tmux 但版本过低，需降级直连。
    TooOld(TmuxVersion),
    /// 未安装、命令不可用或版本串无法识别，需降级直连。附带原因供日志与前端展示。
    Unavailable(String),
}

impl TmuxCapability {
    /// 便于调用方直接判断是否走 control mode。
    pub fn version(&self) -> Option<TmuxVersion> {
        match self {
            TmuxCapability::Supported(v) | TmuxCapability::TooOld(v) => Some(*v),
            TmuxCapability::Unavailable(_) => None,
        }
    }

    pub fn is_supported(&self) -> bool {
        matches!(self, TmuxCapability::Supported(_))
    }
}

/// 从 `tmux -V` 的输出中解析版本号。
///
/// 兼容 `tmux 3.6`、`tmux 3.0a`、开发版 `tmux next-3.7`，以及缺少 `tmux ` 前缀的裸版本串。
/// 无法确定具体版本号的形态（如 `tmux master`）一律返回 `None`——宁可降级直连，
/// 也不要在未知版本上冒险走 control mode。
pub fn parse_version(output: &str) -> Option<TmuxVersion> {
    for token in output.split_whitespace() {
        // 开发版形如 next-3.7，取连字符后的部分
        let candidate = token.rsplit('-').next().unwrap_or(token);
        if let Some(v) = parse_version_token(candidate) {
            return Some(v);
        }
    }
    None
}

fn parse_version_token(token: &str) -> Option<TmuxVersion> {
    let mut chars = token.char_indices();
    let start = chars.find(|(_, c)| c.is_ascii_digit())?.0;
    if start != 0 {
        return None;
    }

    let bytes = token.as_bytes();
    let mut idx = 0;
    let mut major = 0u32;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        major = major
            .checked_mul(10)?
            .checked_add(u32::from(bytes[idx] - b'0'))?;
        idx += 1;
    }
    if idx >= bytes.len() || bytes[idx] != b'.' {
        return None;
    }
    idx += 1;

    let minor_start = idx;
    let mut minor = 0u32;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        minor = minor
            .checked_mul(10)?
            .checked_add(u32::from(bytes[idx] - b'0'))?;
        idx += 1;
    }
    if idx == minor_start {
        return None;
    }

    let suffix = match bytes.get(idx) {
        None => None,
        Some(b) if b.is_ascii_lowercase() => {
            // 后缀只允许单个小写字母，多余内容视为无法识别
            if idx + 1 != bytes.len() {
                return None;
            }
            Some(*b as char)
        }
        // 形如 3.2.1 这类补丁号：忽略补丁位，按 3.2 处理
        Some(b'.') => None,
        Some(_) => return None,
    };

    Some(TmuxVersion {
        major,
        minor,
        suffix,
    })
}

/// 依据 `tmux -V` 的执行结果给出探测结论。
///
/// `exit_code` 为 `None` 表示命令未能执行（如通道打开失败）。
pub fn evaluate(exit_code: Option<i32>, stdout: &str, stderr: &str) -> TmuxCapability {
    let combined = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };

    if exit_code != Some(0) {
        let hint = combined.trim();
        let reason = if hint.is_empty() {
            "远端未安装 tmux 或 tmux -V 执行失败".to_string()
        } else {
            format!("tmux -V 执行失败: {hint}")
        };
        return TmuxCapability::Unavailable(reason);
    }

    match parse_version(combined) {
        Some(v) if v.is_supported() => TmuxCapability::Supported(v),
        Some(v) => TmuxCapability::TooOld(v),
        None => TmuxCapability::Unavailable(format!(
            "无法识别 tmux 版本号: {}",
            combined.trim()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_versions() {
        assert_eq!(parse_version("tmux 3.6"), Some(TmuxVersion::new(3, 6)));
        assert_eq!(parse_version("tmux 3.2"), Some(TmuxVersion::new(3, 2)));
        assert_eq!(parse_version("tmux 2.8"), Some(TmuxVersion::new(2, 8)));
        assert_eq!(parse_version("3.4"), Some(TmuxVersion::new(3, 4)));
    }

    #[test]
    fn parses_lettered_versions() {
        assert_eq!(
            parse_version("tmux 3.0a"),
            Some(TmuxVersion {
                major: 3,
                minor: 0,
                suffix: Some('a')
            })
        );
        assert_eq!(
            parse_version("tmux 3.2a"),
            Some(TmuxVersion {
                major: 3,
                minor: 2,
                suffix: Some('a')
            })
        );
    }

    #[test]
    fn parses_development_versions() {
        assert_eq!(parse_version("tmux next-3.7"), Some(TmuxVersion::new(3, 7)));
    }

    #[test]
    fn ignores_patch_component() {
        assert_eq!(parse_version("tmux 3.2.1"), Some(TmuxVersion::new(3, 2)));
    }

    #[test]
    fn rejects_unrecognizable_versions() {
        assert_eq!(parse_version("tmux master"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("   "), None);
        assert_eq!(parse_version("tmux"), None);
        assert_eq!(parse_version("tmux 3"), None);
        assert_eq!(parse_version("tmux 3."), None);
        assert_eq!(parse_version("tmux 3.2abc"), None);
    }

    #[test]
    fn version_ordering_matches_tmux_release_order() {
        let v30a = parse_version("tmux 3.0a").unwrap();
        let v32 = parse_version("tmux 3.2").unwrap();
        let v32a = parse_version("tmux 3.2a").unwrap();
        let v34 = parse_version("tmux 3.4").unwrap();
        let v36 = parse_version("tmux 3.6").unwrap();

        assert!(v30a < v32, "3.0a 必须小于 3.2");
        assert!(v32 < v32a, "3.2 必须小于 3.2a");
        assert!(v32a < v34);
        assert!(v34 < v36);
    }

    #[test]
    fn support_threshold_matches_compat_matrix() {
        // 与 tmux-compat-matrix.md 的实测结论保持一致
        assert!(!parse_version("tmux 2.8").unwrap().is_supported());
        assert!(!parse_version("tmux 3.0a").unwrap().is_supported());
        assert!(parse_version("tmux 3.2").unwrap().is_supported());
        assert!(parse_version("tmux 3.2a").unwrap().is_supported());
        assert!(parse_version("tmux 3.4").unwrap().is_supported());
        assert!(parse_version("tmux 3.6").unwrap().is_supported());
    }

    #[test]
    fn displays_back_to_original_form() {
        for text in ["3.6", "3.0a", "3.2a", "2.8"] {
            assert_eq!(parse_version(text).unwrap().to_string(), text);
        }
    }

    #[test]
    fn evaluate_accepts_supported_version() {
        let cap = evaluate(Some(0), "tmux 3.4\n", "");
        assert_eq!(cap, TmuxCapability::Supported(TmuxVersion::new(3, 4)));
        assert!(cap.is_supported());
    }

    #[test]
    fn evaluate_flags_too_old_version() {
        let cap = evaluate(Some(0), "tmux 3.0a\n", "");
        assert!(matches!(cap, TmuxCapability::TooOld(_)));
        assert!(!cap.is_supported());
        assert_eq!(cap.version().unwrap().to_string(), "3.0a");
    }

    #[test]
    fn evaluate_handles_missing_binary() {
        let cap = evaluate(Some(127), "", "bash: tmux: command not found");
        match cap {
            TmuxCapability::Unavailable(reason) => assert!(reason.contains("command not found")),
            other => panic!("非预期结论: {other:?}"),
        }
    }

    #[test]
    fn evaluate_handles_unexecutable_command() {
        let cap = evaluate(None, "", "");
        assert!(matches!(cap, TmuxCapability::Unavailable(_)));
        assert_eq!(cap.version(), None);
    }

    #[test]
    fn evaluate_handles_unparsable_version() {
        let cap = evaluate(Some(0), "tmux master", "");
        match cap {
            TmuxCapability::Unavailable(reason) => assert!(reason.contains("master")),
            other => panic!("非预期结论: {other:?}"),
        }
    }

    #[test]
    fn evaluate_falls_back_to_stderr_when_stdout_empty() {
        // 部分系统把版本号写到 stderr
        let cap = evaluate(Some(0), "", "tmux 3.6");
        assert_eq!(cap, TmuxCapability::Supported(TmuxVersion::new(3, 6)));
    }
}
