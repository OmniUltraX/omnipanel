//! Client-tools prompt 构建与 tool_calls JSON 解析（对齐 cursor-gateway translator/client_tools.go）。
//!
//! 提示词正文从 `~/.omnipd/prompts/` 读取（见 omnipanel_store::agent_prompt）。

use serde::Deserialize;

use super::native_tools::TERMINAL_CLIENT_TOOL;
use crate::types::ToolDef;

/// 从 ToolDef 的 JSON Schema 中提取 required / optional 字段名。
fn required_and_optional(parameters: &serde_json::Value) -> (Vec<String>, Vec<String>) {
    let required: Vec<String> = parameters
        .get("required")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let optional: Vec<String> = parameters
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|obj| {
            obj.keys()
                .filter(|k| !required.contains(k))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    (required, optional)
}

fn truncate_desc(s: &str, max_chars: usize) -> String {
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{truncated}…")
}

/// 依据工具清单动态生成 `[Available Functions]` 段（compact schema），
/// 使 ACP 路径与内部 registry 单一真相源一致、随开关变化。
pub fn build_available_functions_section(tools: &[ToolDef]) -> String {
    if tools.is_empty() {
        return String::new();
    }
    let names: Vec<&str> = tools.iter().map(|t| t.function.name.as_str()).collect();

    let mut compact_items: Vec<String> = Vec::with_capacity(tools.len());
    for t in tools {
        let (required, optional) = required_and_optional(&t.function.parameters);
        let item = serde_json::json!({
            "name": t.function.name,
            "description": truncate_desc(&t.function.description, 140),
            "required": required,
            "optional": optional,
        });
        compact_items.push(item.to_string());
    }

    let mut section = String::from("[Available Functions — use ONLY these via tool_calls JSON]\n");
    section.push_str("Callable names: ");
    section.push_str(&names.join(", "));
    section.push('\n');
    section.push_str("Compact schemas (name + short description + required/optional fields):\n");
    section.push('[');
    section.push_str(&compact_items.join(","));
    section.push_str("]\n\n");
    section
}

/// 从模型文本中解析出的客户端 tool_call。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 构建含 preamble + 终端上下文 + 工具定义的完整 client-tools prompt（首轮）。
/// `tools` 为本轮可用的工具清单（来自内部 registry，已按开关/模块过滤）。
pub fn build_client_tools_prompt(
    user_text: &str,
    terminal_context: Option<&str>,
    tools: &[ToolDef],
) -> String {
    let mut preamble = omnipanel_store::client_tools_preamble();
    if !preamble.ends_with('\n') {
        preamble.push('\n');
    }
    let ctx_block = terminal_context
        .filter(|s| !s.trim().is_empty())
        .map(|c| format!("{c}\n\n"))
        .unwrap_or_default();
    let functions_section = build_available_functions_section(tools);
    format!(
        "{preamble}{ctx_block}[User]\n{}\n\n{functions_section}",
        user_text.trim()
    )
}

/// 多轮增量 prompt（不含工具定义附录，ACP session 复用时使用）。
pub fn build_incremental_prompt(user_text: &str) -> String {
    format!("[User]\n{}\n", user_text.trim())
}

/// 多轮增量 prompt + 终端上下文（不含 preamble 与工具定义）。
pub fn build_incremental_client_tools_prompt(
    user_text: &str,
    terminal_context: Option<&str>,
) -> String {
    let ctx_block = terminal_context
        .filter(|s| !s.trim().is_empty())
        .map(|c| format!("{c}\n\n"))
        .unwrap_or_default();
    format!("{ctx_block}{}", build_incremental_prompt(user_text))
}

/// prompt 是否已包含工具执行结果（续轮）。
pub fn prompt_has_tool_results(prompt: &str) -> bool {
    prompt.contains("[Tool Result — ") || prompt.contains("[Function Result]\n")
}

/// 失败工具结果续轮：允许模型再次输出 tool_calls JSON 重试。
pub fn prompt_expects_tool_retry(prompt: &str) -> bool {
    prompt.contains("[System — 命令执行失败]")
}

/// 从工具结果 JSON 提取 exitCode。
pub fn parse_tool_result_exit_code(result: &str) -> Option<i64> {
    let value: serde_json::Value = serde_json::from_str(result).ok()?;
    value
        .get("exitCode")
        .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)))
}

/// 判断 assistant 文本是否可能是未完成的 tool_calls JSON（避免流式泄露半截 JSON）。
pub fn looks_like_pending_tool_calls_json(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    if !parse_client_tool_calls(t).is_empty() {
        return true;
    }
    if !t.starts_with('{') {
        return false;
    }
    if t.contains("\"tool_calls\"") {
        return true;
    }
    // 早期不完整对象：{" 或 {"tool...
    if t.len() < 512 && t.matches('{').count() > t.matches('}').count() {
        return true;
    }
    false
}

/// 从模型输出文本中解析 tool_calls JSON（主路径）。
pub fn parse_client_tool_calls(text: &str) -> Vec<ParsedToolCall> {
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }

    let mut candidates = vec![text.to_string()];
    if let Some(fenced) = extract_json_fence(text) {
        candidates.insert(0, fenced);
    }

    for c in candidates {
        if let Some(calls) = parse_tool_calls_json(&c) {
            return calls;
        }
    }

    if let Some(idx) = text.find("\"tool_calls\"") {
        if let Some(start) = text[..idx].rfind('{') {
            let balanced = extract_balanced_json(&text[start..]);
            if let Some(calls) = parse_tool_calls_json(&balanced) {
                return calls;
            }
        }
    }

    vec![]
}

/// 从解析结果中选取终端工具调用（优先 omni_terminal_run_terminal_command）。
pub fn pick_terminal_tool_call(calls: &[ParsedToolCall]) -> Option<&ParsedToolCall> {
    calls
        .iter()
        .find(|c| c.name == TERMINAL_CLIENT_TOOL)
        .or_else(|| calls.first())
}

fn extract_json_fence(text: &str) -> Option<String> {
    // ```json ... ``` 或 ``` ... ```
    let lower = text.to_lowercase();
    let start_markers = ["```json", "```"];
    for marker in start_markers {
        if let Some(start) = lower.find(marker) {
            let content_start = start + marker.len();
            let rest = &text[content_start..];
            if let Some(end) = rest.find("```") {
                return Some(rest[..end].trim().to_string());
            }
        }
    }
    None
}

#[derive(Debug, Deserialize)]
struct ToolCallsEnvelope {
    #[serde(default)]
    tool_calls: Vec<RawToolCall>,
}

#[derive(Debug, Deserialize)]
struct RawToolCall {
    #[serde(default)]
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    r#type: String,
    function: RawFunction,
}

#[derive(Debug, Deserialize)]
struct RawFunction {
    name: String,
    arguments: serde_json::Value,
}

fn parse_tool_calls_json(s: &str) -> Option<Vec<ParsedToolCall>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    if let Ok(env) = serde_json::from_str::<ToolCallsEnvelope>(s) {
        if !env.tool_calls.is_empty() {
            return Some(normalize_tool_calls(env.tool_calls));
        }
    }

    if let Ok(arr) = serde_json::from_str::<Vec<RawToolCall>>(s) {
        if !arr.is_empty() {
            return Some(normalize_tool_calls(arr));
        }
    }

    None
}

fn normalize_tool_calls(raw: Vec<RawToolCall>) -> Vec<ParsedToolCall> {
    raw.into_iter()
        .filter_map(|tc| {
            let name = tc.function.name.trim();
            if name.is_empty() {
                return None;
            }
            let id = if tc.id.trim().is_empty() {
                format!("call_{}", &uuid_simple())
            } else {
                tc.id
            };
            let arguments = match &tc.function.arguments {
                serde_json::Value::String(s) => s.clone(),
                other => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
            };
            Some(ParsedToolCall {
                id,
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn extract_balanced_json(s: &str) -> String {
    if !s.starts_with('{') {
        return s.to_string();
    }
    let mut depth = 0i32;
    for (i, ch) in s.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return s[..=i].to_string();
                }
            }
            _ => {}
        }
    }
    s.to_string()
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_tool_def() -> ToolDef {
        ToolDef {
            tool_type: "function".to_string(),
            function: crate::types::FunctionDef {
                name: TERMINAL_CLIENT_TOOL.to_string(),
                description: "run terminal command".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "session_id": { "type": "string" }
                    },
                    "required": ["command"]
                }),
            },
        }
    }

    #[test]
    fn build_client_tools_prompt_includes_preamble_and_tools() {
        let tools = [terminal_tool_def()];
        let p = build_client_tools_prompt("当前的时间", None, &tools);
        assert!(p.contains("OmniPanel Client Tool API"));
        assert!(p.contains("[User]\n当前的时间"));
        assert!(p.contains("omni_terminal_run_terminal_command"));
        assert!(p.contains("tool_calls"));
    }

    #[test]
    fn available_functions_section_lists_multiple_tools_and_optional() {
        let db_tool = ToolDef {
            tool_type: "function".to_string(),
            function: crate::types::FunctionDef {
                name: "omni_database_execute_sql".to_string(),
                description: "sql".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "connection_name": { "type": "string" },
                        "database_name": { "type": "string" },
                        "sql": { "type": "string" }
                    },
                    "required": ["connection_name", "database_name", "sql"]
                }),
            },
        };
        let tools = [terminal_tool_def(), db_tool];
        let section = build_available_functions_section(&tools);
        assert!(section.contains("omni_terminal_run_terminal_command"));
        assert!(section.contains("omni_database_execute_sql"));
        // 终端可选字段 session_id 出现在 optional
        assert!(section.contains("session_id"));
        // compact schema 保留短 description
        assert!(section.contains("\"description\":\"run terminal command\""));
    }

    #[test]
    fn available_functions_section_lists_web_tool_without_format_examples() {
        let web_tool = ToolDef {
            tool_type: "function".to_string(),
            function: crate::types::FunctionDef {
                name: "omni_web_search".to_string(),
                description: "联网搜索公开网页信息；检索/查阅意图优先用本工具。".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }),
            },
        };
        let section = build_available_functions_section(&[web_tool]);
        assert!(section.contains("omni_web_search"));
        assert!(section.contains("检索/查阅意图优先"));
        assert!(!section.contains("public-information tools"));
        assert!(!section.contains("Get-Date"));
    }

    #[test]
    fn empty_tools_yields_empty_section() {
        assert!(build_available_functions_section(&[]).is_empty());
    }

    #[test]
    fn parse_tool_calls_from_json() {
        let raw = r#"{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"omni_terminal_run_terminal_command","arguments":"{\"command\":\"date\"}"}}]}"#;
        let calls = parse_client_tool_calls(raw);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, TERMINAL_CLIENT_TOOL);
        assert!(calls[0].arguments.contains("date"));
    }

    #[test]
    fn parse_tool_calls_from_fenced_json() {
        let raw = r#"Here:
```json
{"tool_calls":[{"id":"x","type":"function","function":{"name":"omni_terminal_run_terminal_command","arguments":"{\"command\":\"Get-Date\"}"}}]}
```"#;
        let calls = parse_client_tool_calls(raw);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].arguments.contains("Get-Date"));
    }

    #[test]
    fn looks_like_pending_detects_partial_json() {
        assert!(looks_like_pending_tool_calls_json(r#"{"tool_calls":["#));
        assert!(!looks_like_pending_tool_calls_json("当前时间是下午"));
    }

    #[test]
    fn build_incremental_client_tools_prompt_includes_context() {
        let ctx = "[Terminal Context]\n- Shell: bash";
        let p = build_incremental_client_tools_prompt("随便问一句", Some(ctx));
        assert!(p.contains("[Terminal Context]"));
        assert!(p.contains("[User]\n随便问一句"));
        assert!(!p.contains("OmniPanel Client Tool API"));
    }

    #[test]
    fn build_client_tools_prompt_includes_routing_and_language_rules() {
        let tools = [terminal_tool_def()];
        let p = build_client_tools_prompt("现在几点", None, &tools);
        assert!(p.contains("Choose by intent"));
        assert!(p.contains("omni_web_search"));
        assert!(p.contains("omni_web_fetch"));
        assert!(p.contains("curl, wget"));
        assert!(p.contains("简体中文"));
    }

    #[test]
    fn build_client_tools_prompt_includes_terminal_context() {
        let ctx = "[Terminal Context]\n- Shell: bash\n- OS: Ubuntu";
        let tools = [terminal_tool_def()];
        let p = build_client_tools_prompt("现在几点", Some(ctx), &tools);
        assert!(p.contains("[Terminal Context]"));
        assert!(p.contains("bash"));
    }

    #[test]
    fn parse_exit_code_from_result() {
        let json = r#"{"command":"date","exitCode":127,"output":"not found"}"#;
        assert_eq!(parse_tool_result_exit_code(json), Some(127));
    }
}
