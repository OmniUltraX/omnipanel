pub mod common;
pub mod fetch;
pub mod search;

pub use common::{
    BackendError, FetchRequest, FetchResult, NetKind, RequestCtx, SearchHit, SearchRequest,
    SearchScope, WebSecrets, aggregate_errors, build_http_client, classify_reqwest_error,
    effective_proxy, map_http_status,
};
