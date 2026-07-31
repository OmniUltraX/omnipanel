//! Shared prompt fragments used across HTTP / ACP AI paths.
//!
//! 协议层提示词：`~/.omnipd/prompts/system-prompt.md` → `omnipanel_store::system_prompt()`。
//! 各模块 Agent 角色提示词：`~/.omnipd/prompts/agents/{id}.md` → `omnipanel_store::agent_prompt(id)`。
//! 以下为 HTTP DirectInject 路径的内置工具路由短句（不可配置文件）。

/// HTTP DirectInject 等路径注入的通用工具路由策略（宽泛、按意图匹配）。
pub fn tool_routing_policy() -> String {
    TOOL_ROUTING_POLICY.to_string()
}

const TOOL_ROUTING_POLICY: &str = "Tool selection: use only tools present in this request's tool list; never invent or call tools that are not provided. Match intent to the most specific available capability. Public information search/lookup → omni_web_search (or omni_zhihu_search when fitting) when listed; reading a specific page/URL → omni_web_fetch when listed. Local/session ops, files, and shell work → the matching module tools when listed (e.g. omni_terminal_*). Shell HTTP clients (curl, wget, Invoke-WebRequest, …) remain valid for ops, APIs, debugging, and explicit CLI workflows when a shell tool is available; they should not replace dedicated search/fetch tools when the user’s intent is retrieval. Clarification: when the user must choose among options, confirm a preference, or supply missing critical parameters (host/env/scope/next step), and omni_ask_user is listed, you MUST call omni_ask_user with structured questions — never ask those as plain chat text (no A/B/C or 1/2/3 option lists in the message body).";
