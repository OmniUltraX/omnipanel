//! OmniMCP 模块感知：从 HTTP 请求头 `X-Omni-Module` 解析当前模块，并按模块过滤工具。

use http::request::Parts;
use rmcp::{model::Tool, service::RequestContext, RoleServer};

use crate::types::{OMNI_MODULE_MASTER, X_OMNI_MODULE_HEADER};

/// 从工具名 `omni_{module}_{function}` 解析模块 key。
pub fn omni_tool_module_key(tool_name: &str) -> Option<&str> {
    let rest = tool_name.strip_prefix("omni_")?;
    rest.split_once('_').map(|(module, _)| module)
}

/// 归一化 `X-Omni-Module` 值：空或 `master` 表示不过滤模块。
pub fn normalize_omni_module_header(value: Option<&str>) -> Option<String> {
    let module = value?.trim().to_ascii_lowercase();
    if module.is_empty() || module == OMNI_MODULE_MASTER {
        return None;
    }
    Some(module)
}

/// 从 MCP 请求上下文读取 `X-Omni-Module` 请求头（小写归一化）。
pub fn request_omni_module(context: &RequestContext<RoleServer>) -> Option<String> {
    let raw = context
        .extensions
        .get::<Parts>()
        .and_then(|parts| parts.headers.get(X_OMNI_MODULE_HEADER))
        .and_then(|value| value.to_str().ok());
    normalize_omni_module_header(raw)
}

/// 按模块头与 DB 可用性过滤工具列表。
pub fn filter_tools_for_request(
    tools: Vec<Tool>,
    requested_module: Option<&str>,
    is_available: impl Fn(&str) -> bool,
) -> Vec<Tool> {
    tools
        .into_iter()
        .filter(|tool| {
            let name = tool.name.as_ref();
            if !is_available(name) {
                return false;
            }
            if let Some(module) = requested_module {
                return omni_tool_module_key(name) == Some(module);
            }
            true
        })
        .collect()
}

/// 校验工具是否允许在当前模块上下文中调用。
pub fn ensure_tool_allowed_for_module(
    tool_name: &str,
    requested_module: Option<&str>,
) -> Result<(), String> {
    let Some(module) = requested_module else {
        return Ok(());
    };
    let tool_module = omni_tool_module_key(tool_name).ok_or_else(|| {
        format!("工具 {tool_name} 不符合 omni_{{module}}_{{function}} 命名规范")
    })?;
    if tool_module != module {
        return Err(format!(
            "工具 {tool_name} 不属于模块 {module}（当前 X-Omni-Module 请求头）"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_module_key() {
        assert_eq!(
            omni_tool_module_key("omni_knowledge_create_document"),
            Some("knowledge")
        );
        assert_eq!(
            omni_tool_module_key("omni_database_execute_sql"),
            Some("database")
        );
        assert_eq!(
            omni_tool_module_key("omni_terminal_run_terminal_command"),
            Some("terminal")
        );
        assert_eq!(omni_tool_module_key("other_tool"), None);
    }

    #[test]
    fn ensure_module_rejects_mismatch() {
        let err = ensure_tool_allowed_for_module(
            "omni_knowledge_create_document",
            Some("database"),
        )
        .unwrap_err();
        assert!(err.contains("knowledge"));
        assert!(err.contains("database"));
    }

    #[test]
    fn filter_tools_by_module() {
        let schema = std::sync::Arc::new(serde_json::Map::new());
        let tools = vec![
            Tool::new("omni_knowledge_create_document", "k", schema.clone()),
            Tool::new("omni_database_execute_sql", "d", schema),
        ];
        let filtered = filter_tools_for_request(tools, Some("knowledge"), |_| true);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name.as_ref(), "omni_knowledge_create_document");
    }

    #[test]
    fn master_header_means_all_tools() {
        assert_eq!(normalize_omni_module_header(None), None);
        assert_eq!(normalize_omni_module_header(Some("")), None);
        assert_eq!(normalize_omni_module_header(Some("master")), None);
        assert_eq!(normalize_omni_module_header(Some("MASTER")), None);
        assert_eq!(
            normalize_omni_module_header(Some("database")),
            Some("database".to_string())
        );
    }
}
