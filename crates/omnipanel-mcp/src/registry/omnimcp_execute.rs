//! OmniMCP 统一后端执行入口（与内部 exec_kind 解耦：终端/数据库内部仍走前端，对外走后端）。

use std::sync::Arc;

use omnipanel_store::{builtin_tool_omnimcp_backend, load_http_proxy_config, Storage};
use serde_json::Value;
use tokio::sync::Mutex;

use super::database_tools;
use super::docker_tools;
use super::files_tools;
use super::native;
use super::ssh_tools;
use super::terminal_tools;
use super::web;

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
        "omni_resource_get_profile"
        | "omni_resource_find_similar"
        | "omni_resource_update_profile" => {
            let (text, _) = native::execute(name, arguments, storage.clone(), None).await?;
            Ok(text)
        }
        "omni_skill_recall"
        | "omni_skill_extract_experience"
        | "omni_skill_refine"
        | "omni_skill_report_outcome" => {
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
        "omni_docker_list_connections" => {
            let (text, _) = native::execute(name, arguments, storage.clone(), None).await?;
            Ok(text)
        }
        "omni_files_list_connections" => {
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
        "omni_database_show_processlist" => database_tools::show_processlist(arguments).await,
        "omni_database_kill_query" => database_tools::kill_query(arguments).await,
        "omni_database_slow_log_summary" => database_tools::slow_log_summary(arguments).await,
        "omni_terminal_run_terminal_command" => terminal_tools::run_terminal_command(arguments).await,
        "omni_ssh_exec" => ssh_tools::exec_command(arguments, storage).await,
        "omni_ssh_get_stats" => ssh_tools::get_stats(arguments, storage).await,
        "omni_ssh_list_tunnels" => Ok(serde_json::to_string(&serde_json::json!({
            "tunnels": [],
            "note": "外部 OmniMCP 路径不暴露运行时隧道状态；请在应用内通过内部 AI 调用。"
        }))
        .unwrap_or_else(|_| "{}".to_string())),
        "omni_ssh_create_tunnel" => Err(
            "SSH 隧道创建依赖应用运行时状态（AppState.ssh_tunnels），外部 OmniMCP 路径暂不支持；\
             请在应用内通过内部 AI 调用 omni_ssh_create_tunnel。"
                .to_string(),
        ),
        "omni_docker_list_containers" => docker_tools::list_containers(arguments, storage).await,
        "omni_docker_container_logs" => docker_tools::container_logs(arguments, storage).await,
        "omni_docker_inspect_container" => {
            docker_tools::inspect_container(arguments, storage).await
        }
        "omni_docker_container_action" => {
            docker_tools::container_action(arguments, storage).await
        }
        "omni_docker_exec" => docker_tools::exec(arguments, storage).await,
        "omni_files_list" => files_tools::list(arguments, storage).await,
        "omni_files_read" => files_tools::read(arguments, storage).await,
        "omni_files_write" => files_tools::write(arguments, storage).await,
        "omni_files_search" => files_tools::search(arguments, storage).await,
        "omni_web_search" => {
            let proxy = load_http_proxy_config().ok();
            let (text, _) = web::search::dispatch(arguments, storage, proxy).await?;
            Ok(text)
        }
        "omni_zhihu_search" => {
            let proxy = load_http_proxy_config().ok();
            let (text, _) = web::search::dispatch_zhihu_only(arguments, storage, proxy).await?;
            Ok(text)
        }
        "omni_web_fetch" => {
            let proxy = load_http_proxy_config().ok();
            let (text, _) = web::fetch::dispatch(arguments, storage, proxy).await?;
            Ok(text)
        }
        other => Err(format!("工具 {other} 未注册 OmniMCP 执行器")),
    }
}
