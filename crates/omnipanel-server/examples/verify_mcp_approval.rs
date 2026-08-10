//! 端到端验证：Web 端外部 MCP 工具审批接入。
//!
//! 前置：
//! 1. `python3 docs/web/mock_mcp_server.py 18080`
//! 2. 运行 `cargo run -p omnipanel-server --example verify_mcp_approval`
//!
//! 逻辑：
//! 1. 注册外部 MCP SSE 服务（mock_echo）
//! 2. 开启审批（`mcp_set_external_require_approval(true)`，默认即开启）
//! 3. 用 `ServerToolExecutor` 触发一次外部工具调用 → 应广播 `tool-approval-required`
//!    （挂起等待审批），同时起一个任务调 `ai_chat_tool_result(approved=true)` → 服务端自执，
//!   返回 mock_echo 结果
//! 4. 再用另一个 tool_call_id 触发一次 → 浏览器拒绝（approved=false）→ 返回拒绝
//! 5. 关闭审批后再调一次 → 直接自执，无需审批
//! 6. 全部通过打印 OK，退出码 0

use std::sync::Arc;
use std::time::Duration;

use omnipanel_ai::ToolExecutor;
use omnipanel_server::ai::ai_chat_tool_result;
use omnipanel_server::ai_tools::ServerToolExecutor;
use omnipanel_server::mcp::{
    mcp_delete_service, mcp_set_external_require_approval, mcp_upsert_service,
    UpsertMcpServiceInput,
};
use omnipanel_server::state::ServerState;
use omnipanel_mcp::McpTransportKind;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(ServerState::new());

    // 0. 清理历史残留
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
    let service_id = view.id.clone();
    tokio::time::sleep(Duration::from_millis(300)).await;
    println!("OK upsert service: {service_id}");

    // 2. 确保审批开启（默认即 true，显式设置以明确断言）
    mcp_set_external_require_approval(&state, true)
        .await
        .map_err(|e| format!("enable approval: {e}"))?;
    assert!(
        state
            .mcp_external_require_approval
            .load(std::sync::atomic::Ordering::Relaxed),
        "审批应开启"
    );

    let ext_name = format!("extmcp::{service_id}::mock_echo");

    // 3. 触发外部工具调用（开启审批）→ 广播审批事件 + 等待浏览器回传批准
    {
        let tool_call_id = "tc-approve".to_string();
        let conv = "conv-approve".to_string();
        let exec_name = ext_name.clone();
        // 起一个任务模拟浏览器收到 `tool-approval-required` 后批准（执行器在主线程运行，
        // 审批任务并发执行，验证 oneshot 通道在 await 期间可被 IPC 触发）
        let st = state.clone();
        let conv2 = conv.clone();
        let tcid2 = tool_call_id.clone();
        let approver = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            ai_chat_tool_result(&st, conv2, tcid2, "user approved".to_string(), true)
                .await
                .map_err(|e| format!("approve result: {e}"))
        });
        let exec = ServerToolExecutor::new(&state, None).with_conversation(conv.clone());
        let (content, success) = exec
            .execute(&tool_call_id, &exec_name, r#"{"text":"hello approve"}"#)
            .await;
        let r = approver.await??;
        println!("OK approve ack: {r:?}");
        println!("OK executor after approve: success={success} content={content:?}");
        assert!(success, "审批通过后执行失败: {content}");
        assert!(content.contains("echo:hello approve"), "内容不符: {content}");
    }

    // 4. 触发另一次调用 → 浏览器拒绝
    {
        let tool_call_id = "tc-reject".to_string();
        let conv = "conv-reject".to_string();
        let exec_name = ext_name.clone();
        let st = state.clone();
        let conv2 = conv.clone();
        let tcid2 = tool_call_id.clone();
        let rejecter = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            ai_chat_tool_result(&st, conv2, tcid2, "user rejected".to_string(), false)
                .await
                .map_err(|e| format!("reject result: {e}"))
        });
        let exec = ServerToolExecutor::new(&state, None).with_conversation(conv.clone());
        let (content, success) = exec
            .execute(&tool_call_id, &exec_name, r#"{"text":"hello reject"}"#)
            .await;
        let r = rejecter.await??;
        println!("OK reject ack: {r:?}");
        println!("OK executor after reject: success={success} content={content:?}");
        assert!(!success, "拒绝后不应成功: {content}");
    }

    // 5. 关闭审批后 → 服务端直接自执，无需审批
    {
        mcp_set_external_require_approval(&state, false)
            .await
            .map_err(|e| format!("disable approval: {e}"))?;
        let exec = ServerToolExecutor::new(&state, None);
        let (content, success) = exec
            .execute("tc-direct", &ext_name, r#"{"text":"hello direct"}"#)
            .await;
        println!("OK executor direct (no approval): success={success} content={content:?}");
        assert!(success, "关闭审批后直接自执失败: {content}");
        assert!(content.contains("echo:hello direct"), "内容不符: {content}");
    }

    // 6. 清理
    mcp_delete_service(&state, service_id.clone())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    println!("OK delete service");

    println!("\nALL MCP APPROVAL VERIFY PASSED ✅");
    Ok(())
}
