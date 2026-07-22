use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::ir::{StreamEvent, ToolStatus};
use crate::providers::acp::native_tools::{
    NativeToolKind, TERMINAL_CLIENT_TOOL, classify_native_tool, extract_native_shell_command,
    is_native_shell_tool, map_native_shell_to_terminal_tool, map_native_tool_by_kind,
};
use crate::providers::acp::types::SessionUpdateNotification;

/// ACP session/update 翻译选项（对齐 cursor-gateway client-tools 模式）。
#[derive(Clone, Default)]
pub struct TranslateOptions {
    /// 将 Cursor 内置 shell 工具映射为客户端终端工具，并抑制原生 tool_call_update。
    pub client_tools: bool,
    /// 抑制所有原生工具调用（不映射、不透传）。用于 gateway 路径。
    pub suppress_all_native: bool,
    /// 已被映射为客户端工具的原生 toolCallId 集合。
    pub suppressed_native_ids: Arc<Mutex<HashSet<String>>>,
    /// shell 工具已识别但 rawInput 尚未含 command，等待 tool_call_update 补全。
    pub deferred_shell_ids: Arc<Mutex<HashSet<String>>>,
    /// 累积各 toolCallId 的最新 rawInput（流式补全参数）。
    pub pending_native_raw: Arc<Mutex<HashMap<String, serde_json::Value>>>,
}

impl TranslateOptions {
    pub fn new(client_tools: bool, suppress_all_native: bool) -> Self {
        Self {
            client_tools,
            suppress_all_native,
            suppressed_native_ids: Arc::new(Mutex::new(HashSet::new())),
            deferred_shell_ids: Arc::new(Mutex::new(HashSet::new())),
            pending_native_raw: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Translate an ACP `session/update` notification into IR StreamEvents (SDK v1).
pub fn translate_session_update(params: &SessionUpdateNotification) -> Vec<StreamEvent> {
    translate_update_value(&params.update, &TranslateOptions::default())
}

pub fn translate_update_value(
    update: &serde_json::Value,
    options: &TranslateOptions,
) -> Vec<StreamEvent> {
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" | "user_message_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentDelta { text }]
            }
        }
        "agent_thought_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ReasoningDelta { text }]
            }
        }
        "tool_call" => translate_tool_call(update, options),
        "tool_call_update" => translate_tool_call_update(update, options),
        "plan" => {
            let text = extract_plan_text(update);
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentDelta {
                    text: format!("📝 **Plan:**\n{text}\n"),
                }]
            }
        }
        _ => vec![],
    }
}

/// 对齐 cursor-gateway stream.go EventToolCall 分支 + translator.MapNativeToolToClient：
/// 1. 先查 rawInput 是否含 shell 命令（`command`/`shellToolCall`/`script`），这是最优先判断
/// 2. 再看工具名/title 是否为 shell 类
/// 3. Shell → 重写为 `omni_terminal_run_terminal_command` + Pending
/// 4. 非 shell（WebSearch/WebFetch/Read/Write/Edit/Find/Grep）→ 按 NativeToolKind 映射
/// 5. 无法识别 → client-tools 模式下抑制该 tool_call，防止 UI 卡住
fn translate_tool_call(update: &serde_json::Value, options: &TranslateOptions) -> Vec<StreamEvent> {
    let tool_call_id = update
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let title = update
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let name = update
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let raw_input = update
        .get("rawInput")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    // Gateway 路径：抑制所有原生工具，强制 agent 只使用 prompt 注入的客户端工具
    if options.suppress_all_native {
        tracing::debug!(
            "ACP native tool suppressed (suppress_all_native): name={name:?} title={title:?} id={tool_call_id}"
        );
        options
            .suppressed_native_ids
            .lock()
            .unwrap()
            .insert(tool_call_id);
        return vec![];
    }

    if options.client_tools {
        // 第二次 tool_call 携带完整 rawInput（同一 toolCallId）
        {
            let deferred = options.deferred_shell_ids.lock().unwrap();
            if deferred.contains(&tool_call_id) {
                drop(deferred);
                let merged = merge_native_raw_input(options, &tool_call_id, &raw_input);
                if let Some(events) = try_emit_deferred_shell_tool(options, &tool_call_id, &merged)
                {
                    return events;
                }
            }
        }

        // 对齐 gateway: 先查 rawInput，再查工具名
        let has_shell_cmd = extract_native_shell_command(&raw_input).is_some();
        let is_shell_name = is_native_shell_tool(&name, &title);

        if has_shell_cmd || is_shell_name {
            options
                .pending_native_raw
                .lock()
                .unwrap()
                .insert(tool_call_id.clone(), raw_input.clone());

            if has_shell_cmd {
                if let Some(arguments) = map_native_shell_to_terminal_tool(&raw_input) {
                    options
                        .suppressed_native_ids
                        .lock()
                        .unwrap()
                        .insert(tool_call_id.clone());
                    options
                        .deferred_shell_ids
                        .lock()
                        .unwrap()
                        .remove(&tool_call_id);
                    return vec![
                        StreamEvent::ToolCall {
                            id: tool_call_id.clone(),
                            name: TERMINAL_CLIENT_TOOL.to_string(),
                            arguments,
                        },
                        StreamEvent::ToolCallUpdate {
                            id: tool_call_id,
                            status: ToolStatus::Pending,
                            result: None,
                        },
                    ];
                }
            }

            if is_shell_name {
                options
                    .deferred_shell_ids
                    .lock()
                    .unwrap()
                    .insert(tool_call_id.clone());
                return vec![StreamEvent::ToolCall {
                    id: tool_call_id,
                    name: TERMINAL_CLIENT_TOOL.to_string(),
                    arguments: "{}".to_string(),
                }];
            }
        }

        // 非 shell 原生工具 → 按 NativeToolKind 分类映射
        let kind = classify_native_tool(&name, &title);
        if kind != NativeToolKind::Shell && kind != NativeToolKind::Other {
            if let Some((tool_name, arguments)) = map_native_tool_by_kind(kind, &raw_input) {
                tracing::debug!(
                    "ACP native tool mapped: name={name:?} title={title:?} kind={kind:?} -> {tool_name} id={tool_call_id}"
                );
                options
                    .suppressed_native_ids
                    .lock()
                    .unwrap()
                    .insert(tool_call_id.clone());
                return vec![
                    StreamEvent::ToolCall {
                        id: tool_call_id.clone(),
                        name: tool_name.to_string(),
                        arguments,
                    },
                    StreamEvent::ToolCallUpdate {
                        id: tool_call_id,
                        status: ToolStatus::Pending,
                        result: None,
                    },
                ];
            }
            // 映射失败（rawInput 参数不完整）→ 抑制
            tracing::debug!(
                "ACP native tool suppressed (mapping failed): name={name:?} title={title:?} kind={kind:?} id={tool_call_id}"
            );
            options
                .suppressed_native_ids
                .lock()
                .unwrap()
                .insert(tool_call_id);
            return vec![];
        }

        // 真正无法识别的工具 → 抑制
        tracing::debug!(
            "ACP native tool suppressed (unknown): name={name:?} title={title:?} id={tool_call_id}"
        );
        options
            .suppressed_native_ids
            .lock()
            .unwrap()
            .insert(tool_call_id);
        return vec![];
    }

    // 非 client-tools 模式：原样透传
    let arguments = serde_json::to_string(&raw_input).unwrap_or_else(|_| "{}".to_string());
    vec![StreamEvent::ToolCall {
        id: tool_call_id,
        name: if name.is_empty() { title } else { name },
        arguments,
    }]
}

fn merge_native_raw_input(
    options: &TranslateOptions,
    id: &str,
    raw_input: &serde_json::Value,
) -> serde_json::Value {
    let mut map = options.pending_native_raw.lock().unwrap();
    let merged = if let Some(existing) = map.get(id) {
        merge_json_values(existing, raw_input)
    } else {
        raw_input.clone()
    };
    map.insert(id.to_string(), merged.clone());
    merged
}

fn merge_json_values(base: &serde_json::Value, patch: &serde_json::Value) -> serde_json::Value {
    match (base, patch) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            let mut merged = a.clone();
            for (k, v) in b {
                merged.insert(k.clone(), v.clone());
            }
            serde_json::Value::Object(merged)
        }
        (_, patch) => patch.clone(),
    }
}

fn try_emit_deferred_shell_tool(
    options: &TranslateOptions,
    id: &str,
    raw_input: &serde_json::Value,
) -> Option<Vec<StreamEvent>> {
    if extract_native_shell_command(raw_input).is_none() {
        return None;
    }
    let arguments = map_native_shell_to_terminal_tool(raw_input)?;
    options
        .deferred_shell_ids
        .lock()
        .unwrap()
        .remove(id);
    options
        .suppressed_native_ids
        .lock()
        .unwrap()
        .insert(id.to_string());
    Some(vec![
        StreamEvent::ToolCall {
            id: id.to_string(),
            name: TERMINAL_CLIENT_TOOL.to_string(),
            arguments,
        },
        StreamEvent::ToolCallUpdate {
            id: id.to_string(),
            status: ToolStatus::Pending,
            result: None,
        },
    ])
}

fn translate_tool_call_update(
    update: &serde_json::Value,
    options: &TranslateOptions,
) -> Vec<StreamEvent> {
    let id = update
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    if options.client_tools {
        if let Some(raw_input) = update.get("rawInput") {
            let merged = merge_native_raw_input(options, &id, raw_input);
            {
                let deferred = options.deferred_shell_ids.lock().unwrap();
                if deferred.contains(&id) {
                    drop(deferred);
                    if let Some(events) = try_emit_deferred_shell_tool(options, &id, &merged) {
                        return events;
                    }
                    return vec![];
                }
            }
        }

        let suppressed = options.suppressed_native_ids.lock().unwrap();
        if suppressed.contains(&id) {
            return vec![];
        }
    }

    let status = update
        .get("status")
        .and_then(|v| v.as_str())
        .map(parse_tool_status)
        .unwrap_or(ToolStatus::Running);
    let result = update.get("rawOutput").map(|v| {
        if v.is_string() {
            v.as_str().unwrap_or("").to_string()
        } else {
            serde_json::to_string(v).unwrap_or_default()
        }
    });
    vec![StreamEvent::ToolCallUpdate {
        id,
        status,
        result,
    }]
}

fn extract_content_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Object(obj)) => {
            if let Some(serde_json::Value::String(text)) = obj.get("text") {
                return text.clone();
            }
            if let Some(serde_json::Value::Array(blocks)) = obj.get("content") {
                return blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
            }
            String::new()
        }
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn extract_plan_text(update: &serde_json::Value) -> String {
    if let Some(entries) = update.get("entries").and_then(|v| v.as_array()) {
        return entries
            .iter()
            .filter_map(|e| e.get("content").and_then(|c| c.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
    }
    extract_content_text(update.get("content"))
}

fn parse_tool_status(s: &str) -> ToolStatus {
    match s {
        "pending" => ToolStatus::Pending,
        "in_progress" | "running" => ToolStatus::Running,
        "completed" | "done" | "success" => ToolStatus::Completed,
        "failed" | "error" => ToolStatus::Failed,
        _ => ToolStatus::Running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::acp::native_tools::{WEB_FETCH_CLIENT_TOOL, WEB_SEARCH_CLIENT_TOOL};

    fn test_options() -> TranslateOptions {
        TranslateOptions::new(true, false)
    }

    #[test]
    fn client_tools_maps_shell_by_name() {
        let options = test_options();
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc1",
            "title": "powershell",
            "rawInput": {
                "shellToolCall": { "args": { "command": "Get-Date" } }
            }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2);
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, TERMINAL_CLIENT_TOOL);
                assert!(arguments.contains("Get-Date"));
            }
            _ => panic!("expected tool_call"),
        }
    }

    #[test]
    fn client_tools_maps_shell_by_raw_input_command_field() {
        let options = test_options();
        // Cursor 常见情况：title 是命令本身（如 "date"），rawInput 有 command 字段
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc2",
            "title": "date",
            "rawInput": { "command": "date" }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2, "should map to terminal tool + pending: {:?}", events);
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, TERMINAL_CLIENT_TOOL);
                assert!(arguments.contains("date"));
            }
            _ => panic!("expected mapped tool_call"),
        }
    }

    #[test]
    fn client_tools_maps_find_to_terminal_command() {
        let options = test_options();
        // "Find" 是 Cursor 的文件搜索原生工具，映射为 find 命令
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc3",
            "title": "Find",
            "rawInput": { "query": "*.rs", "path": "/src" }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2, "Find should map to terminal tool + pending");
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, TERMINAL_CLIENT_TOOL);
                assert!(arguments.contains("find"), "should use find command: {arguments}");
                assert!(arguments.contains("*.rs"), "should contain query: {arguments}");
            }
            _ => panic!("expected tool_call"),
        }
    }

    #[test]
    fn client_tools_maps_web_search() {
        let options = test_options();
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc_ws",
            "title": "WebSearch",
            "rawInput": { "query": "rust async runtime" }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2, "WebSearch should map to omni_web_search + pending");
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, WEB_SEARCH_CLIENT_TOOL);
                assert!(arguments.contains("rust async runtime"));
            }
            _ => panic!("expected tool_call"),
        }
    }

    #[test]
    fn client_tools_maps_web_fetch() {
        let options = test_options();
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc_wf",
            "title": "WebFetch",
            "rawInput": { "url": "https://example.com/docs" }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2, "WebFetch should map to omni_web_fetch + pending");
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, WEB_FETCH_CLIENT_TOOL);
                assert!(arguments.contains("https://example.com/docs"));
            }
            _ => panic!("expected tool_call"),
        }
    }

    #[test]
    fn client_tools_maps_read_to_cat() {
        let options = test_options();
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc_rd",
            "title": "Read",
            "rawInput": { "file_path": "/tmp/test.txt" }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2, "Read should map to terminal cat command");
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, TERMINAL_CLIENT_TOOL);
                assert!(arguments.contains("cat"), "should use cat: {arguments}");
                assert!(arguments.contains("/tmp/test.txt"));
            }
            _ => panic!("expected tool_call"),
        }
    }

    #[test]
    fn client_tools_suppresses_unknown_native_tool() {
        let options = test_options();
        // "CodebaseIndex" 是无法识别的工具
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc_unk",
            "title": "CodebaseIndex",
            "rawInput": { "action": "index" }
        });
        let events = translate_update_value(&update, &options);
        assert!(events.is_empty(), "unknown native tool should be suppressed");
    }

    #[test]
    fn client_tools_defers_shell_until_raw_input_complete() {
        let options = test_options();
        let initial = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc_defer",
            "title": "powershell",
            "rawInput": {}
        });
        let events = translate_update_value(&initial, &options);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ToolCall { name, arguments, .. } => {
                assert_eq!(name, TERMINAL_CLIENT_TOOL);
                assert_eq!(arguments, "{}");
            }
            _ => panic!("expected deferred tool_call"),
        }

        let update = serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc_defer",
            "status": "in_progress",
            "rawInput": {
                "shellToolCall": { "args": { "command": "date" } }
            }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 2);
        match &events[0] {
            StreamEvent::ToolCall { arguments, .. } => {
                assert!(arguments.contains("date"));
            }
            _ => panic!("expected completed tool_call"),
        }
    }

    #[test]
    fn non_client_tools_passes_through() {
        let options = TranslateOptions::default();
        let update = serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc4",
            "title": "date",
            "rawInput": { "command": "date" }
        });
        let events = translate_update_value(&update, &options);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ToolCall { name, .. } => {
                assert_eq!(name, "date");
            }
            _ => panic!("expected tool_call"),
        }
    }
}
