//! 兼容层：旧 `web_tools` 路径 re-export 新 `web` 模块。

pub use super::web::{
    aggregate_errors, build_http_client, effective_proxy, BackendError, NetKind, SearchHit,
};
pub use super::web::fetch;
pub use super::web::search::{dispatch as search, dispatch_zhihu_only, search_auto_for_test, search_exa, test_provider};
pub use super::web::fetch::{dispatch as fetch, test_fetch};
