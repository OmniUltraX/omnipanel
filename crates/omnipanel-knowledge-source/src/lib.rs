//! 知识源管线宿主 runner：适配器供数（L2 插件或原生实现），引擎负责比对、落库、归档、报告。
//!
//! 切分原则见 [`adapter`]：插件只读，不管写。

pub mod adapter;
pub mod engine;
pub mod local;

pub use adapter::{
    AdapterOptions, KsDocContent, KsDocRef, KsNotebook, MethodCaller, PluginAdapter, SourceAdapter,
};
pub use engine::{KsFailure, KsReport, rebuild_source, sync_source};
pub use local::{MAX_PARSE_BYTES, PluginLocalAdapter, read_local_file, walk_local_files};

/// 当前毫秒时间戳.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
