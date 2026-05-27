pub mod local;
pub mod remote;
pub mod session;

pub use local::{LocalSession, ShellKind, detect_shell};
pub use session::TerminalSession;
