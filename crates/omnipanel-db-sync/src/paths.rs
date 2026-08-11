use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniResult;
use omnipanel_store::module_dir;

fn database_module_dir() -> Result<PathBuf, String> {
    module_dir("database").map_err(|e| e.user_message())
}

fn ensure_subdir(name: &str) -> Result<PathBuf, String> {
    let dir = database_module_dir()?.join(name);
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败 ({name}): {e}"))?;
    Ok(dir)
}

/// 数据同步 SQL 脚本缓存目录：`~/.omnipd/database/data-sync-sql`
pub fn sync_sql_dir() -> Result<PathBuf, String> {
    ensure_subdir("data-sync-sql")
}

/// 行级差异缓存目录：`~/.omnipd/database/sync-row-diffs`
pub fn row_diff_cache_dir() -> Result<PathBuf, String> {
    ensure_subdir("sync-row-diffs")
}

/// MySQL 导出根目录：`~/.omnipd/database/mysql-exports`
pub fn exports_root() -> Result<PathBuf, String> {
    ensure_subdir("mysql-exports")
}

/// 将（可编辑后的）同步 SQL 写入缓存目录，返回可执行路径。
pub fn save_sync_sql_file(sql: &str) -> Result<String, String> {
    let dir = sync_sql_dir()?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("sync-{millis}.sql"));
    fs::write(&path, sql).map_err(|e| format!("写入 SQL 文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取 `sync_sql_dir` 下的 SQL 文件（路径必须在缓存目录内）。
pub fn read_sync_sql_file(sql_file_path: &str) -> Result<String, String> {
    let dir = sync_sql_dir()?;
    let dir_canonical = dir.canonicalize().unwrap_or(dir);
    let requested = PathBuf::from(sql_file_path);
    let resolved = requested
        .canonicalize()
        .map_err(|e| format!("SQL 文件不存在或无法访问: {e}"))?;
    if !resolved.starts_with(&dir_canonical) {
        return Err("不允许读取该 SQL 文件路径".to_string());
    }
    fs::read_to_string(resolved).map_err(|e| format!("读取 SQL 文件失败: {e}"))
}

/// 连接级 MySQL 导出子目录。
pub fn connection_exports_dir(connection_id: &str) -> Result<PathBuf, String> {
    let dir = exports_root()?.join(connection_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建连接导出目录失败: {e}"))?;
    Ok(dir)
}

/// 校验路径在指定根目录下（用于导出文件删除/复制安全校验）。
pub fn path_under_base(base: &Path, path: &Path) -> Result<PathBuf, String> {
    let base_canonical = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("文件无法访问: {e}"))?;
    if !canonical.starts_with(&base_canonical) {
        return Err("不允许访问该路径".to_string());
    }
    Ok(canonical)
}

#[allow(dead_code)]
pub(crate) fn map_omni_result(path: OmniResult<PathBuf>) -> Result<PathBuf, String> {
    path.map_err(|e| e.user_message())
}
