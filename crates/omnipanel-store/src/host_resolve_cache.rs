//! 域名→IP 解析结果缓存（`~/.omnipd/database/host-resolve-cache.json`）。
//! 避免每次匹配 SSH/数据库主机时重复 DNS 解析。

use std::collections::HashMap;
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths;

/// 缓存条目：域名→解析到的地址列表 + 解析时间戳。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostResolveEntry {
    pub addresses: Vec<String>,
    /// 秒级时间戳。
    #[serde(default)]
    #[serde(rename = "resolvedAt")]
    pub resolved_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct HostResolveCacheFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, HostResolveEntry>,
}

fn default_version() -> u32 {
    1
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写主机解析缓存失败").with_cause(err.to_string())
}

fn map_json(err: serde_json::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "解析主机解析缓存失败").with_cause(err.to_string())
}

/// 从磁盘加载全部缓存条目；文件不存在时返回空 Map。
pub fn load_host_resolve_cache() -> OmniResult<HashMap<String, HostResolveEntry>> {
    let path = paths::database_host_resolve_cache_path()?;
    load_host_resolve_cache_from(&path)
}

pub fn load_host_resolve_cache_from(path: &Path) -> OmniResult<HashMap<String, HostResolveEntry>> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(path).map_err(map_io)?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let file: HostResolveCacheFile = serde_json::from_str(&content).map_err(map_json)?;
    Ok(file.entries)
}

/// 将全部缓存条目写回磁盘（原子替换）。
pub fn save_host_resolve_cache(entries: &HashMap<String, HostResolveEntry>) -> OmniResult<()> {
    let path = paths::database_host_resolve_cache_path()?;
    save_host_resolve_cache_to(&path, entries)
}

pub fn save_host_resolve_cache_to(
    path: &Path,
    entries: &HashMap<String, HostResolveEntry>,
) -> OmniResult<()> {
    let file = HostResolveCacheFile {
        version: 1,
        entries: entries.clone(),
    };
    let content = serde_json::to_string_pretty(&file).map_err(map_json)?;
    // 原子写：先写临时文件再重命名。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

/// 查询缓存中某域名对应的地址列表（不存在则返回 None）。
pub fn get_cached_addresses(
    entries: &HashMap<String, HostResolveEntry>,
    host: &str,
) -> Option<Vec<String>> {
    let key = host.trim().to_lowercase();
    if key.is_empty() {
        return None;
    }
    entries.get(&key).map(|e| e.addresses.clone())
}

/// 写入/更新一条缓存记录。
pub fn upsert_cache_entry(
    entries: &mut HashMap<String, HostResolveEntry>,
    host: &str,
    addresses: Vec<String>,
    resolved_at: i64,
) {
    let key = host.trim().to_lowercase();
    if key.is_empty() {
        return;
    }
    entries.insert(
        key,
        HostResolveEntry {
            addresses,
            resolved_at,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_and_get() {
        let mut map = HashMap::new();
        upsert_cache_entry(&mut map, "example.com", vec!["1.2.3.4".into()], 100);
        let got = get_cached_addresses(&map, "example.com").unwrap();
        assert_eq!(got, vec!["1.2.3.4".to_string()]);
        // 键不区分大小写
        let got = get_cached_addresses(&map, "EXAMPLE.COM").unwrap();
        assert_eq!(got, vec!["1.2.3.4".to_string()]);
    }

    #[test]
    fn empty_host_is_ignored() {
        let mut map = HashMap::new();
        upsert_cache_entry(&mut map, "  ", vec!["1.1.1.1".into()], 1);
        assert!(get_cached_addresses(&map, "  ").is_none());
        assert!(map.is_empty());
    }
}