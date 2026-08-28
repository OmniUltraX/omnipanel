//! P1 共享状态：持久化存储、DB 连接池、SSH 会话、Docker 连接缓存。
//!
//! Web 端是无界面进程，无法使用桌面端依赖 `tauri::AppHandle` 的 `AppState`，
//! 因此这里从 `omnipanel-store` / `omnipanel-ssh` / `omnipanel-docker` 等纯 Rust
//! crate 组装等价能力，与桌面端共用同一套领域逻辑。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use omnipanel_error::OmniResult;
use omnipanel_ssh::{SshConfig, SshSession};
use omnipanel_store::DbConnectionConfig;

/// `ServerState` 定义在 [`crate::terminal`]（P0 遗留），这里 re-export 供 P1 模块统一引用。
pub use crate::terminal::ServerState;

/// 元数据库根（当前团队 `~/.omnipd/store/teams/{scope}/omnipanel.db`）。
pub fn open_meta_storage() -> OmniResult<Arc<Mutex<omnipanel_store::Storage>>> {
    let _ = omnipanel_store::init_team_storage();
    let db_path = omnipanel_store::meta_db_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let storage = omnipanel_store::Storage::open(&db_path, None)?;
    Ok(Arc::new(Mutex::new(storage)))
}

/// 打开 DB 连接仓库（`~/.omnipd/database/connections.json`）。
pub fn open_db_connections() -> OmniResult<Arc<omnipanel_store::DatabaseConnectionStore>> {
    Ok(Arc::new(omnipanel_store::DatabaseConnectionStore::open()?))
}

/// 读取 DB 连接并注入 Vault 密码（供建连）。
pub fn db_connection_with_secret(
    store: &omnipanel_store::DatabaseConnectionStore,
    id: &str,
) -> OmniResult<Option<DbConnectionConfig>> {
    store.get_with_secret(id)
}

/// SSH 会话表（交互式 shell，与桌面端 `ssh_sessions` 同构）。
pub type SshSessionMap = Arc<Mutex<HashMap<String, Arc<SshSession>>>>;

/// 按连接 id 解析 SSH 配置（复用 `omnipanel-store::inject_ssh_vault_into_config`，
/// 与桌面端 `commands::connection::resolve_ssh_config` 逻辑等价）。
pub fn resolve_ssh_config(
    conn: &omnipanel_store::Connection,
) -> OmniResult<SshConfig> {
    let (patched, password) = omnipanel_store::inject_ssh_vault_into_config(
        &conn.config,
        &conn.id,
        conn.credential_ref.as_deref(),
    )?;
    omnipanel_ssh::ssh_config_from_json(&patched, password.as_deref())
}
