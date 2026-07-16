//! 应用数据根目录 `~/.omnipd`（Windows 为 `%USERPROFILE%\.omnipd`）。
//! 各功能模块使用独立子目录存放持久化文件。

use std::path::PathBuf;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};

pub const OMNIPD_DIR_NAME: &str = ".omnipd";

/// 已知的模块数据目录名。
pub mod modules {
    pub const DATABASE: &str = "database";
    pub const STORE: &str = "store";
    #[allow(dead_code)]
    pub const SSH: &str = "ssh";
    #[allow(dead_code)]
    pub const TERMINAL: &str = "terminal";
    #[allow(dead_code)]
    pub const DOCKER: &str = "docker";
    pub const MCP: &str = "mcp";
    pub const SKILLS: &str = "skills";
    pub const AI: &str = "ai";
    pub const FILES: &str = "files";
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

/// 返回 `~/.omnipd`，若不存在则创建。
pub fn omnipd_root() -> OmniResult<PathBuf> {
    let home =
        home_dir().ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "无法定位用户主目录"))?;
    let root = home.join(OMNIPD_DIR_NAME);
    std::fs::create_dir_all(&root).map_err(map_io)?;
    Ok(root)
}

/// 返回并确保模块子目录存在，例如 `~/.omnipd/database`。
pub fn module_dir(module: &str) -> OmniResult<PathBuf> {
    let dir = omnipd_root()?.join(module);
    std::fs::create_dir_all(&dir).map_err(map_io)?;
    Ok(dir)
}

/// 元数据 SQLite 库：`~/.omnipd/store/omnipanel.db`（连接模型、审计日志等）。
pub fn meta_db_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::STORE)?.join("omnipanel.db"))
}

/// 数据库模块连接列表：`~/.omnipd/database/connections.json`。
pub fn database_connections_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::DATABASE)?.join("connections.json"))
}

/// Schema 树过滤显示：`~/.omnipd/database/schema-filters.json`。
pub fn database_schema_filters_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::DATABASE)?.join("schema-filters.json"))
}

/// Schema 树展开状态：`~/.omnipd/database/schema-tree-expanded.json`。
pub fn database_schema_tree_expanded_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::DATABASE)?.join("schema-tree-expanded.json"))
}

/// Schema 树节点缓存：`~/.omnipd/database/schema-cache.json`。
pub fn database_schema_cache_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::DATABASE)?.join("schema-cache.json"))
}

/// Docker 侧栏资源缓存：`~/.omnipd/docker/sidebar-cache.json`。
pub fn docker_sidebar_cache_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::DOCKER)?.join("sidebar-cache.json"))
}

/// MCP 服务配置：`~/.omnipd/mcp/services.json`。
pub fn mcp_services_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::MCP)?.join("services.json"))
}

/// 产品级 Skills 根目录：`~/.omnipd/skills/`。
pub fn skills_root() -> OmniResult<PathBuf> {
    module_dir(modules::SKILLS)
}

/// AI 配置目录：`~/.omnipd/ai/`。
pub fn ai_config_dir() -> OmniResult<PathBuf> {
    module_dir(modules::AI)
}

/// 对话提供者注册表：`~/.omnipd/ai/providers.json`。
pub fn ai_providers_path() -> OmniResult<PathBuf> {
    Ok(ai_config_dir()?.join("providers.json"))
}

/// CLI 自定义提供者：`~/.omnipd/ai/cli-providers.json`。
pub fn cli_providers_path() -> OmniResult<PathBuf> {
    Ok(ai_config_dir()?.join("cli-providers.json"))
}

/// Web 搜索配置：`~/.omnipd/ai/web-search.json`。
pub fn web_search_config_path() -> OmniResult<PathBuf> {
    Ok(ai_config_dir()?.join("web-search.json"))
}

/// HTTP 代理配置：`~/.omnipd/ai/http-proxy.json`。
pub fn http_proxy_config_path() -> OmniResult<PathBuf> {
    Ok(ai_config_dir()?.join("http-proxy.json"))
}

/// 默认文件索引存储目录：`~/.omnipd/files/index`。
pub fn default_file_index_storage_dir() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::FILES)?.join("index"))
}

/// 域名→IP 解析缓存：`~/.omnipd/database/host-resolve-cache.json`。
pub fn database_host_resolve_cache_path() -> OmniResult<PathBuf> {
    Ok(module_dir(modules::DATABASE)?.join("host-resolve-cache.json"))
}

pub(crate) fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写应用数据目录失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_dir_is_under_root() {
        let root = omnipd_root().unwrap();
        let db_dir = module_dir(modules::DATABASE).unwrap();
        assert!(db_dir.starts_with(&root));
        assert!(db_dir.ends_with("database"));
    }

    #[test]
    fn database_connections_path_name() {
        let path = database_connections_path().unwrap();
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some("connections.json")
        );
        assert!(
            path.parent()
                .is_some_and(|p| p.ends_with(modules::DATABASE))
        );
    }
}
