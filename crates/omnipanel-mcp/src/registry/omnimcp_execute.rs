//! OmniMCP 统一后端执行入口（与内部 exec_kind 解耦：终端/数据库内部仍走前端，对外走后端）。

use std::sync::Arc;

use omnipanel_store::{builtin_tool_omnimcp_backend, load_http_proxy_config, Storage};
use serde_json::Value;
use tokio::sync::Mutex;

use super::database_tools;
use super::native;
use super::terminal_tools;
use super::web_tools;

/// 在 OmniMCP HTTP 路径执行工具；返回 JSON 文本。
pub async fn execute_omnimcp_tool(
    name: &str,
    arguments: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<String, String> {
    if !builtin_tool_omnimcp_backend(name) {
        return Err(format!("工具 {name} 尚未实现 OmniMCP 后端执行"));
    }

    match name {
        "omni_knowledge_create_document"
        | "omni_knowledge_remove_document"
        | "omni_knowledge_list_documents" => {
            let (text, _) = native::execute(name, arguments, storage.clone(), None).await?;
            Ok(text)
        }
        "load_skill" => {
            let (text, _) = native::execute(name, arguments, storage.clone(), None).await?;
            Ok(text)
        }
        "omni_database_list_connections" => {
            let (text, _) = native::execute(name, arguments, storage.clone(), None).await?;
            Ok(text)
        }
        "omni_ssh_list_connections" => {
            let (text, _) = native::execute(name, arguments, storage.clone(), None).await?;
            Ok(text)
        }
        "omni_database_get_databases_from_connection" => {
            database_tools::get_databases_from_connection(arguments).await
        }
        "omni_database_get_tables_from_database" => {
            database_tools::get_tables_from_database(arguments).await
        }
        "omni_database_get_table_info" => database_tools::get_table_info(arguments).await,
        "omni_database_execute_sql" => database_tools::execute_sql(arguments).await,
        "omni_terminal_run_terminal_command" => terminal_tools::run_terminal_command(arguments).await,
        "omni_web_search" => {
            let proxy = load_http_proxy_config().ok();
            let (text, _) = web_tools::search(arguments, storage, proxy).await?;
            Ok(text)
        }
        "omni_web_fetch" => {
            let proxy = load_http_proxy_config().ok();
            let (text, _) = web_tools::fetch(arguments, storage, proxy).await?;
            Ok(text)
        }
        other => Err(format!("工具 {other} 未注册 OmniMCP 执行器")),
    }
}
