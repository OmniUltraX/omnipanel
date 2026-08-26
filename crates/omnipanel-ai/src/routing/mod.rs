pub mod backend_id;
pub mod http_api;

pub use backend_id::{normalize_cli_backend, parse_backend_id, BackendKind, ParsedBackendId};
pub use http_api::{
    HttpInferenceApi, model_requires_anthropic_messages_api, resolve_anthropic_messages_base_url,
    resolve_http_inference_api,
};
