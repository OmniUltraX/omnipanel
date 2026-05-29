//! 本地存储与凭据库：rusqlite 元数据存储（密钥注入式，可选 SQLCipher）+ keyring 凭据保管。

mod connection;
mod storage;
mod vault;

pub use connection::{Connection, ConnectionKind};
pub use storage::{AuditEntry, Storage};
pub use vault::Vault;
