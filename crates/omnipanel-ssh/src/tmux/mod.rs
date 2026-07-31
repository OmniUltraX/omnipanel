//! tmux control mode（`tmux -CC`）支持：行协议解析、远端能力探测。
//!
//! 用途是把「一条 SSH 连接承载多个远程终端 Tab」与「会话跨进程存活」两件事
//! 交给远端 tmux 完成，而不是在应用层模拟。
//!
//! # 硬性约束
//!
//! 设置 `window-size` 时**必须**使用 window 级作用域
//! （`set-option -w -t @N window-size manual`），**严禁**使用 `-g`。
//! 实测在 global 作用域生效期间执行 `new-window` 会导致 tmux 3.4 / 3.6 的
//! **服务端直接崩溃**，该主机上全部会话一并丢失。详见
//! `openspec/changes/ssh-tmux-persistent-sessions/tmux-compat-matrix.md`。

pub mod commands;
pub mod controller;
pub mod line;
pub mod parser;
pub mod probe;
pub mod registry;
pub mod session;

pub use commands::{
    control_mode_command, is_omnipanel_session, kill_session_shell, list_sessions_shell,
    parse_session_line, sanitize_session_name, session_name_for_workspace, version_probe_command,
    TmuxSessionInfo, DEFAULT_HISTORY_LIMIT, SESSION_PREFIX,
};
pub use controller::{ControllerEvent, TmuxController};
pub use line::LineAssembler;
pub use session::{TmuxControl, TmuxSink};
pub use parser::{
    parse_line, unescape_octal, CommandTag, ControlEvent, PaneId, SessionId, WindowId,
};
pub use probe::{evaluate, parse_version, TmuxCapability, TmuxVersion, MIN_SUPPORTED};
pub use registry::{PaneEntry, PaneRegistry};
