//! Everything 本机文件搜索：仅返回路径元数据，不读文件内容，也不自动启动 Everything。

use serde::Serialize;

pub const MAX_RESULTS_CAP: u32 = 200;
pub const DEFAULT_MAX_RESULTS: u32 = 50;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EverythingHit {
    pub path: String,
    pub is_folder: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EverythingError {
    #[error("当前平台不支持 Everything 搜索")]
    UnsupportedPlatform,
    #[error("未检测到 Everything。请先启动 Everything，OmniPanel 不会自动启动它。")]
    NotRunning,
    #[error("查询不能为空")]
    EmptyQuery,
    #[error("Everything 查询失败: {0}")]
    Query(String),
}

pub fn clamp_max_results(max_results: u32) -> u32 {
    max_results.clamp(1, MAX_RESULTS_CAP)
}

pub mod ipc;

#[cfg(windows)]
mod win;

#[cfg(windows)]
pub fn search(query: &str, max_results: u32) -> Result<Vec<EverythingHit>, EverythingError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(EverythingError::EmptyQuery);
    }
    win::search(trimmed, clamp_max_results(max_results))
}

#[cfg(not(windows))]
pub fn search(_query: &str, _max_results: u32) -> Result<Vec<EverythingHit>, EverythingError> {
    Err(EverythingError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_max_results() {
        assert_eq!(clamp_max_results(0), 1);
        assert_eq!(clamp_max_results(50), 50);
        assert_eq!(clamp_max_results(9999), MAX_RESULTS_CAP);
    }

    #[test]
    fn empty_query_rejected() {
        let err = search("   ", 10).unwrap_err();
        #[cfg(windows)]
        assert_eq!(err, EverythingError::EmptyQuery);
        #[cfg(not(windows))]
        assert_eq!(err, EverythingError::UnsupportedPlatform);
    }

    #[cfg(not(windows))]
    #[test]
    fn stub_platform() {
        assert_eq!(
            search("readme.md", 10).unwrap_err(),
            EverythingError::UnsupportedPlatform
        );
    }

    #[cfg(windows)]
    #[test]
    fn missing_or_ok_when_everything_absent() {
        match search("omnipanel_everything_unlikely_zzz_query", 5) {
            Ok(hits) => assert!(
                hits.is_empty()
                    || hits
                        .iter()
                        .all(|h| crate::ipc::looks_like_win_path(&h.path)),
                "unexpected garbage hits: {hits:?}"
            ),
            Err(EverythingError::NotRunning) => {}
            Err(other) => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn parse_list2_fixture_keeps_windows_paths() {
        let mut buf = Vec::new();
        buf.extend(1u32.to_le_bytes());
        buf.extend(1u32.to_le_bytes());
        buf.extend(0u32.to_le_bytes());
        buf.extend(4u32.to_le_bytes());
        buf.extend(1u32.to_le_bytes());
        buf.extend(0u32.to_le_bytes());
        buf.extend(28u32.to_le_bytes());
        for unit in r"C:\omni\readme.txt".encode_utf16() {
            buf.extend(unit.to_le_bytes());
        }
        buf.extend(0u16.to_le_bytes());
        let hits = ipc::parse_list2(&buf).expect("list2");
        assert_eq!(hits[0].path, r"C:\omni\readme.txt");
        assert!(ipc::hits_look_valid(&hits));
        assert!(!ipc::hits_look_valid(&[EverythingHit {
            path: "D".into(),
            is_folder: true,
        }]));
    }

    #[test]
    fn strip_pipe_length_prefix_roundtrip() {
        let body = b"abcd";
        let mut framed = Vec::from(4u32.to_le_bytes());
        framed.extend_from_slice(body);
        assert_eq!(ipc::strip_pipe_length_prefix(&framed), body);
    }
}
