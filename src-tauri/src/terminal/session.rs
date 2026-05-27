use std::time::Instant;

use super::local::LocalSession;

/// Unified terminal session — local PTY or remote SSH.
pub enum TerminalSession {
    Local(LocalSession),
    Remote(RemoteSession),
}

/// Placeholder for Phase 2 SSH integration.
pub struct RemoteSession {
    pub id: String,
    pub created_at: Instant,
}

impl TerminalSession {
    pub fn id(&self) -> &str {
        match self {
            Self::Local(s) => &s.id,
            Self::Remote(s) => &s.id,
        }
    }

    pub fn write(&mut self, data: &[u8]) -> anyhow::Result<()> {
        match self {
            Self::Local(s) => s.write(data),
            Self::Remote(_) => anyhow::bail!("SSH sessions not yet implemented"),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        match self {
            Self::Local(s) => s.resize(cols, rows),
            Self::Remote(_) => anyhow::bail!("SSH sessions not yet implemented"),
        }
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Local(s) => s.kill(),
            Self::Remote(_) => Ok(()),
        }
    }
}
