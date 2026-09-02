//! 1Panel 面板版本探测与端点路由。
//!
//! 各代面板的 API 差异（决定调用哪个端点）：
//! - v2.2+：容器终端 `/api/v2/hosts/terminal/container`（`operateNode=local`）、
//!   宿主机终端 `/api/v2/hosts/terminal/local`、容器文件 `POST /api/v2/containers/files/*`
//! - v2.0–v2.1：容器终端 `/api/v2/containers/exec`；无容器文件 API
//! - v1：容器终端 `/api/v1/containers/exec`；无容器文件 API
//!
//! 版本经面板 OS 信息端点探测（v2 `GET /api/v2/dashboard/base/os`、
//! v1 `POST /api/v1/dashboard/current/os`，取 `data.version`）。
//! 客户端在每次命令调用时重建，实例字段无法跨调用复用，
//! 因此用进程级缓存（key = base_url|entrance），探测失败不缓存、下次重试。

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

/// 解析后的 1Panel 版本号。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OnePanelVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl OnePanelVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    pub fn is_at_least(&self, major: u32, minor: u32) -> bool {
        (self.major, self.minor) >= (major, minor)
    }

    /// 解析 `v2.0.5`、`2.2.0`、`v1.10.32-lts`、`v2.0.5-beta.1` 等形态。
    /// 主版本为 0 或无法解析出数字时视为无效。
    pub fn parse(raw: &str) -> Option<Self> {
        let cleaned = raw.trim().trim_start_matches(['v', 'V']);
        let head = cleaned.split(['-', '+']).next()?.trim();
        if head.is_empty() {
            return None;
        }
        let mut parts = head.split('.');
        let major = parts.next()?.trim().parse::<u32>().ok()?;
        if major == 0 {
            return None;
        }
        let parse_part =
            |part: Option<&str>| -> u32 { part.and_then(|s| s.trim().parse().ok()).unwrap_or(0) };
        Some(Self {
            major,
            minor: parse_part(parts.next()),
            patch: parse_part(parts.next()),
        })
    }
}

fn cache() -> &'static RwLock<HashMap<String, OnePanelVersion>> {
    static CACHE: OnceLock<RwLock<HashMap<String, OnePanelVersion>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn cached_version(key: &str) -> Option<OnePanelVersion> {
    cache().read().ok()?.get(key).copied()
}

pub fn remember_version(key: &str, version: OnePanelVersion) {
    if let Ok(mut map) = cache().write() {
        map.insert(key.to_string(), version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_semver_with_prefix() {
        assert_eq!(
            OnePanelVersion::parse("v2.0.5"),
            Some(OnePanelVersion::new(2, 0, 5))
        );
        assert_eq!(
            OnePanelVersion::parse("2.2.10"),
            Some(OnePanelVersion::new(2, 2, 10))
        );
    }

    #[test]
    fn parses_prebuild_and_lts_suffixes() {
        assert_eq!(
            OnePanelVersion::parse("v2.0.5-beta.1"),
            Some(OnePanelVersion::new(2, 0, 5))
        );
        assert_eq!(
            OnePanelVersion::parse("v1.10.32-lts"),
            Some(OnePanelVersion::new(1, 10, 32))
        );
    }

    #[test]
    fn parses_short_forms() {
        assert_eq!(
            OnePanelVersion::parse("v2"),
            Some(OnePanelVersion::new(2, 0, 0))
        );
        assert_eq!(
            OnePanelVersion::parse("v2.1"),
            Some(OnePanelVersion::new(2, 1, 0))
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(OnePanelVersion::parse(""), None);
        assert_eq!(OnePanelVersion::parse("unknown"), None);
        assert_eq!(OnePanelVersion::parse("v0.1.2"), None);
        assert_eq!(OnePanelVersion::parse("vx.y.z"), None);
    }

    #[test]
    fn is_at_least_compares_major_minor() {
        let v = OnePanelVersion::new(2, 0, 5);
        assert!(v.is_at_least(2, 0));
        assert!(!v.is_at_least(2, 1));
        assert!(v.is_at_least(1, 9));
        assert!(OnePanelVersion::new(2, 1, 0).is_at_least(2, 1));
    }

    #[test]
    fn version_cache_roundtrip() {
        let key = format!("test-cache-{}", std::process::id());
        assert!(cached_version(&key).is_none());
        remember_version(&key, OnePanelVersion::new(2, 2, 0));
        assert_eq!(cached_version(&key), Some(OnePanelVersion::new(2, 2, 0)));
    }
}
