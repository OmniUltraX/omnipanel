//! 按同步团队隔离本地业务数据目录：`~/.omnipd/store/teams/{scope}/`。

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths::{self, map_io, module_dir, modules};

/// 未登录或尚未选定团队时的本机目录名。
pub const LOCAL_TEAM_SCOPE: &str = "local";

#[derive(Debug, Serialize, Deserialize)]
struct ActiveTeamFile {
    #[serde(default)]
    scope: String,
}

fn active_scope_lock() -> &'static RwLock<String> {
    static LOCK: OnceLock<RwLock<String>> = OnceLock::new();
    LOCK.get_or_init(|| RwLock::new(LOCAL_TEAM_SCOPE.to_string()))
}

fn read_scope() -> String {
    active_scope_lock()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn write_scope(scope: String) {
    *active_scope_lock()
        .write()
        .unwrap_or_else(|e| e.into_inner()) = scope;
}

/// 规范化团队目录名：空 / 非法 → `local`。
pub fn normalize_team_scope(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0" {
        return LOCAL_TEAM_SCOPE.to_string();
    }
    if trimmed.len() <= 64
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        trimmed.to_string()
    } else {
        LOCAL_TEAM_SCOPE.to_string()
    }
}

pub fn active_team_scope() -> String {
    normalize_team_scope(&read_scope())
}

pub fn set_active_team_scope(scope: &str) {
    write_scope(normalize_team_scope(scope));
}

fn active_team_file_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::STORE)?.join("active-team.json"))
}

fn load_persisted_scope() -> String {
    let Ok(path) = active_team_file_path() else {
        return LOCAL_TEAM_SCOPE.to_string();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return LOCAL_TEAM_SCOPE.to_string();
    };
    serde_json::from_str::<ActiveTeamFile>(&raw)
        .map(|f| normalize_team_scope(&f.scope))
        .unwrap_or_else(|_| LOCAL_TEAM_SCOPE.to_string())
}

pub fn persist_active_team_scope(scope: &str) -> OmniResult<()> {
    let scope = normalize_team_scope(scope);
    let path = active_team_file_path()?;
    let json = serde_json::to_string_pretty(&ActiveTeamFile { scope })
        .map_err(|e| OmniError::new(ErrorCode::Storage, "写入当前团队失败").with_cause(e.to_string()))?;
    std::fs::write(path, json).map_err(map_io)?;
    Ok(())
}

/// 当前团队业务数据根：`~/.omnipd/store/teams/{scope}/`。
pub fn team_data_dir() -> OmniResult<PathBuf> {
    let dir = module_dir(modules::STORE)?
        .join("teams")
        .join(active_team_scope());
    std::fs::create_dir_all(&dir).map_err(map_io)?;
    Ok(dir)
}

pub fn team_database_dir() -> OmniResult<PathBuf> {
    let dir = team_data_dir()?.join(modules::DATABASE);
    std::fs::create_dir_all(&dir).map_err(map_io)?;
    Ok(dir)
}

fn move_file_if_absent(src: &Path, dest: &Path) -> OmniResult<()> {
    if !src.is_file() || dest.is_file() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    if std::fs::rename(src, dest).is_err() {
        std::fs::copy(src, dest).map_err(map_io)?;
        let _ = std::fs::remove_file(src);
    }
    Ok(())
}

fn move_sqlite_bundle(src_db: &Path, dest_db: &Path) -> OmniResult<()> {
    move_file_if_absent(src_db, dest_db)?;
    let src_name = src_db
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("omnipanel.db");
    let dest_name = dest_db
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("omnipanel.db");
    for suffix in ["-wal", "-shm"] {
        let src = src_db.with_file_name(format!("{src_name}{suffix}"));
        let dest = dest_db.with_file_name(format!("{dest_name}{suffix}"));
        move_file_if_absent(&src, &dest)?;
    }
    Ok(())
}

fn move_dir_contents_if_dest_empty(src: &Path, dest: &Path) -> OmniResult<()> {
    if !src.is_dir() {
        return Ok(());
    }
    let dest_empty = !dest.exists()
        || std::fs::read_dir(dest)
            .map(|mut it| it.next().is_none())
            .unwrap_or(true);
    if !dest_empty {
        return Ok(());
    }
    std::fs::create_dir_all(dest).map_err(map_io)?;
    for entry in std::fs::read_dir(src).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let to = dest.join(entry.file_name());
        let from = entry.path();
        if std::fs::rename(&from, &to).is_err() {
            if from.is_dir() {
                copy_dir_recursive(&from, &to)?;
                let _ = std::fs::remove_dir_all(&from);
            } else {
                std::fs::copy(&from, &to).map_err(map_io)?;
                let _ = std::fs::remove_file(&from);
            }
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> OmniResult<()> {
    std::fs::create_dir_all(dest).map_err(map_io)?;
    for entry in std::fs::read_dir(src).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(map_io)?;
        }
    }
    Ok(())
}

/// 把升级前的全局路径迁进当前团队目录（仅当目标还不存在对应文件）。
pub fn migrate_legacy_into_current_team() -> OmniResult<()> {
    let dest_root = team_data_dir()?;
    let dest_db = dest_root.join("omnipanel.db");
    let legacy_db = module_dir(modules::STORE)?.join("omnipanel.db");
    if legacy_db.is_file() && !dest_db.is_file() {
        move_sqlite_bundle(&legacy_db, &dest_db)?;
    }

    let dest_database = team_database_dir()?;
    let legacy_database = module_dir(modules::DATABASE)?;
    // 旧布局是 `~/.omnipd/database/`，不要把已在 teams/ 下的目录再迁一次
    if legacy_database.is_dir() && !legacy_database.starts_with(module_dir(modules::STORE)?.join("teams"))
    {
        move_dir_contents_if_dest_empty(&legacy_database, &dest_database)?;
    }

    let dest_index = dest_root.join("files-index");
    let legacy_index = module_dir(modules::FILES)?.join("index");
    move_dir_contents_if_dest_empty(&legacy_index, &dest_index)?;

    let dest_knowledge = dest_root.join(modules::KNOWLEDGE).join("assets");
    let legacy_knowledge = module_dir(modules::KNOWLEDGE)?.join("assets");
    move_dir_contents_if_dest_empty(&legacy_knowledge, &dest_knowledge)?;

    let dest_docker = dest_root.join(modules::DOCKER).join("sidebar-cache.json");
    let legacy_docker = module_dir(modules::DOCKER)?.join("sidebar-cache.json");
    move_file_if_absent(&legacy_docker, &dest_docker)?;
    Ok(())
}

/// 登录后把 `teams/local` 整目录改名为个人团队 id（目标尚无主库时）。
pub fn promote_local_dir_to_team(team_scope: &str) -> OmniResult<bool> {
    let team_scope = normalize_team_scope(team_scope);
    if team_scope == LOCAL_TEAM_SCOPE {
        return Ok(false);
    }
    let teams = module_dir(modules::STORE)?.join("teams");
    let local = teams.join(LOCAL_TEAM_SCOPE);
    let dest = teams.join(&team_scope);
    let local_db = local.join("omnipanel.db");
    let dest_db = dest.join("omnipanel.db");
    if !local_db.is_file() || dest_db.is_file() {
        return Ok(false);
    }
    if dest.exists() {
        let empty = std::fs::read_dir(&dest)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if empty {
            let _ = std::fs::remove_dir(&dest);
        } else {
            return Ok(false);
        }
    }
    std::fs::create_dir_all(&teams).map_err(map_io)?;
    if std::fs::rename(&local, &dest).is_err() {
        copy_dir_recursive(&local, &dest)?;
        let _ = std::fs::remove_dir_all(&local);
    }
    Ok(true)
}

/// 读取上次团队、迁旧布局、作为后续 path 函数的当前 scope。
pub fn init_team_storage() -> OmniResult<String> {
    let scope = load_persisted_scope();
    set_active_team_scope(&scope);
    migrate_legacy_into_current_team()?;
    persist_active_team_scope(&scope)?;
    Ok(scope)
}

/// 主库文件在打开前是否已存在（用于判断「空团队，可拉云端」）。
pub fn meta_db_exists_on_disk() -> bool {
    paths::meta_db_path()
        .map(|p| p.is_file())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_empty_and_path() {
        assert_eq!(normalize_team_scope(""), LOCAL_TEAM_SCOPE);
        assert_eq!(normalize_team_scope("0"), LOCAL_TEAM_SCOPE);
        assert_eq!(normalize_team_scope("../x"), LOCAL_TEAM_SCOPE);
        assert_eq!(normalize_team_scope("12"), "12");
        assert_eq!(normalize_team_scope("local"), "local");
    }
}
