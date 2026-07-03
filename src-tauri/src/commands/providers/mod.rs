//! 统一对话提供者注册表：`~/.omnipd/ai/providers.json`（HTTP + CLI）。

pub mod registry;

pub use registry::{cli_provider_list, provider_list_models};
