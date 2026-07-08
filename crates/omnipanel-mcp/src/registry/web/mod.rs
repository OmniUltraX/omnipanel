pub mod common;
pub mod fetch;
pub mod search;

pub use common::{
    aggregate_errors, build_http_client, classify_reqwest_error, effective_proxy, map_http_status,
    BackendError, FetchRequest, FetchResult, NetKind, RequestCtx, SearchHit, SearchRequest,
    SearchScope, WebSecrets,
};
