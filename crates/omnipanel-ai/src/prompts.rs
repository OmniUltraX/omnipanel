//! Shared prompt fragments used across HTTP / ACP AI paths.
//!
//! 协议层提示词：`~/.omnipd/prompts/system-prompt.md` → `omnipanel_store::system_prompt()`。
//! 各模块 Agent 角色提示词：`~/.omnipd/prompts/agents/{id}.md` → `omnipanel_store::agent_prompt(id)`。
//! 工具路由：`resources/prompts/routing-policy.md`（HTTP 与 ACP 共用）。

/// HTTP DirectInject / ACP 共用的工具路由策略。
pub fn tool_routing_policy() -> String {
    omnipanel_store::routing_policy().trim().to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn http_routing_matches_store_ssot() {
        let http = super::tool_routing_policy();
        let store = omnipanel_store::routing_policy().trim();
        assert_eq!(http, store);
        assert!(http.contains("omni_terminal_exec"));
        assert!(http.contains("omni_ssh_exec"));
        assert!(http.contains("resource_id"));
        assert!(http.contains("omni_ask_user"));
    }
}
