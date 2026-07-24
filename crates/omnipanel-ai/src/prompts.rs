//! Shared prompt fragments used across HTTP / ACP AI paths.
//!
//! 智能体主提示词见 `~/.omnipd/prompts/system-prompt.md` → `omnipanel_store::system_prompt()`。
//! 以下为 HTTP DirectInject 路径的内置工具路由短句（不可配置文件）。

/// HTTP DirectInject 等路径注入的通用工具路由策略（宽泛、按意图匹配）。
pub fn tool_routing_policy() -> String {
    TOOL_ROUTING_POLICY.to_string()
}

const TOOL_ROUTING_POLICY: &str = "Tool selection: match intent to the most specific host capability. Public information search/lookup → omni_web_search (or omni_zhihu_search when fitting); reading a specific page/URL → omni_web_fetch when listed. Local/session ops, files, and shell work → the matching module tools (e.g. omni_terminal_*). Shell HTTP clients (curl, wget, Invoke-WebRequest, …) remain valid for ops, APIs, debugging, and explicit CLI workflows; they should not replace dedicated search/fetch tools when the user’s intent is retrieval.";
