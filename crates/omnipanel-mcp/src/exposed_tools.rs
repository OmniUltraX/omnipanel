//! 从后端 spec + DB 开关动态装配 OmniMCP 对外工具列表。

use std::sync::Arc;

use omnipanel_store::{Storage, BUILTIN_TOOL_SPECS};
use rmcp::model::Tool;

use crate::registry::native;

/// 合并 rmcp 宏注册工具与 spec 中已开启对外暴露、但尚未在 router 中的工具。
pub fn merge_exposed_spec_tools(storage: &Storage, router_tools: Vec<Tool>) -> Vec<Tool> {
    let router_names: std::collections::HashSet<String> = router_tools
        .iter()
        .map(|t| t.name.as_ref().to_string())
        .collect();

    let mut out = router_tools;
    for spec in BUILTIN_TOOL_SPECS {
        if router_names.contains(spec.tool_name) {
            continue;
        }
        if !storage
            .builtin_tool_is_exposed_available(spec.tool_name)
            .unwrap_or(false)
        {
            continue;
        }
        let schema = resolve_tool_input_schema(storage, spec.tool_name, spec.input_schema);
        out.push(Tool::new(
            spec.tool_name,
            spec.description,
            schema,
        ));
    }
    out
}

fn resolve_tool_input_schema(
    _storage: &Storage,
    tool_name: &str,
    fallback_json: &str,
) -> Arc<serde_json::Map<String, serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_str(fallback_json).unwrap_or_else(|_| {
        native::input_schema_for(tool_name)
    });
    match value {
        serde_json::Value::Object(map) => Arc::new(map),
        _ => Arc::new(serde_json::Map::new()),
    }
}
