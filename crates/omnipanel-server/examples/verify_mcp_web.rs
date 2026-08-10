//! 端到端验证：Web 端 MCP 外部服务桥接。
//!
//! 前置：
//! 1. `python3 docs/web/mock_mcp_server.py 18080`
//! 2. 运行 `cargo run -p omnipanel-server --example verify_mcp_web`
//!
//! 逻辑：
//! 1. 通过 `mcp_upsert_service` 注册一个 SSE 外部 MCP 服务（指向 mock 服务器）
//! 2. `mcp_list_services` 确认服务状态
//! 3. `mcp_list_service_tools` 列出 mock_echo
//! 4. `mcp_call_tool` 调用 mock_echo → echo 结果
//! 5. `merge_external_tool_defs` 确认外部工具并入 AI 工具面（extmcp::*）
//! 6. 清理：删除服务

use std::sync::Arc;

use omnipanel_server::mcp::{
    mcp_call_tool, mcp_delete_service, mcp_list_service_tools, mcp_upsert_service,
    merge_external_tool_defs, UpsertMcpServiceInput,
};
use omnipanel_server::state::ServerState;
use omnipanel_mcp::McpTransportKind;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(ServerState::new());

    // 0. 清理历史测试残留（同 name 的 mock 服务），保证外部工具面断言唯一
    {
        let shared = state
            .ensure_mcp_manager()
            .await
            .ok_or("MCP 管理器初始化失败")?;
        let mut manager = shared.lock().await;
        let stale: Vec<String> = manager
            .list_services()
            .into_iter()
            .filter(|s| !s.builtin && s.name == "mock-mcp")
            .map(|s| s.id)
            .collect();
        for id in stale {
            let _ = manager.delete_service(&id).await;
        }
    }

    // 1. 注册外部 MCP SSE 服务
    let view = mcp_upsert_service(
        &state,
        UpsertMcpServiceInput {
            id: None,
            name: "mock-mcp".to_string(),
            enabled: true,
            transport_kind: McpTransportKind::Sse,
            command: None,
            args: vec![],
            env: vec![],
            cwd: None,
            url: Some("http://127.0.0.1:18080/mcp".to_string()),
        },
    )
    .await
    .map_err(|e| format!("upsert: {e}"))?;
    println!("OK upsert: id={} status={:?}", view.id, view.status);
    let service_id = view.id.clone();

    // 等待服务就绪
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // 2. 列出工具
    let tools = mcp_list_service_tools(&state, service_id.clone())
        .await
        .map_err(|e| format!("list tools: {e}"))?;
    println!("OK list tools: {:?}", tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>());
    assert!(tools.iter().any(|t| t.name == "mock_echo"), "缺少 mock_echo");

    // 3. 调用工具
    let result = mcp_call_tool(
        &state,
        service_id.clone(),
        "mock_echo".to_string(),
        r#"{"text":"hello web mcp"}"#.to_string(),
    )
    .await
    .map_err(|e| format!("call tool: {e}"))?;
    println!("OK call tool: content={:?} is_error={}", result.content, result.is_error);
    assert!(!result.is_error);
    assert!(result.content.contains("echo:hello web mcp"), "echo 内容不符: {}", result.content);

    // 4. AI 工具面并入（无模块过滤 → master 语义）
    let defs = merge_external_tool_defs(&state, None)
        .await
        .map_err(|e| format!("merge external defs: {e}"))?;
    let ext_names: Vec<String> = defs
        .iter()
        .map(|d| d.function.name.clone())
        .filter(|n| n.starts_with("extmcp::"))
        .collect();
    println!("OK external tool defs injected: {ext_names:?}");
    assert!(
        ext_names.iter().any(|n| n.contains("mock_echo")),
        "外部工具未注入工具面: {ext_names:?}"
    );

    // 4b. 经 ServerToolExecutor（AI 执行器）桥接外部 MCP 工具
    {
        use omnipanel_ai::ToolExecutor;
        let executor = omnipanel_server::ai_tools::ServerToolExecutor::new(&state, None);
        let ext_name = ext_names
            .iter()
            .find(|n| n.contains("mock_echo"))
            .cloned()
            .ok_or("缺少 extmcp::mock_echo 工具名")?;
        let (content, success) = executor
            .execute("t1", &ext_name, r#"{"text":"via executor"}"#)
            .await;
        println!("OK executor bridge: success={success} content={content:?}");
        assert!(success, "executor 调用失败: {content}");
        assert!(content.contains("echo:via executor"), "executor 内容不符: {content}");
    }

    // 5. 清理
    mcp_delete_service(&state, service_id.clone())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    println!("OK delete service");

    println!("\nALL MCP WEB VERIFY PASSED ✅");
    Ok(())
}
