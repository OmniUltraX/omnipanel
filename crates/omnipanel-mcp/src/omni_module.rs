//! OmniMCP 模块感知：从 HTTP 请求头 `X-Omni-Module` 解析当前模块，并按模块过滤工具。

use http::request::Parts;
use rmcp::{model::Tool, service::RequestContext, RoleServer};

use crate::types::{OMNI_MODULE_MASTER, X_OMNI_MODULE_HEADER};

/// 请求头 `X-Omni-Module` 解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OmniModuleScope {
    /// 未携带请求头或值为空：不暴露任何工具。
    Unspecified,
    /// `X-Omni-Module=master`：返回全部可用工具。
    All,
    /// 指定模块（如 `knowledge`、`database`）。
    Module(String),
}

/// 从工具名 `omni_{module}_{function}` 解析模块 key。
pub fn omni_tool_module_key(tool_name: &str) -> Option<&str> {
    let rest = tool_name.strip_prefix("omni_")?;
    rest.split_once('_').map(|(module, _)| module)
}

/// 解析 `X-Omni-Module` 请求头值。
pub fn parse_omni_module_header(value: Option<&str>) -> OmniModuleScope {
    let Some(raw) = value else {
        return OmniModuleScope::Unspecified;
    };
    let module = raw.trim().to_ascii_lowercase();
    if module.is_empty() {
        return OmniModuleScope::Unspecified;
    }
    if module == OMNI_MODULE_MASTER {
        return OmniModuleScope::All;
    }
    OmniModuleScope::Module(module)
}

/// 从 MCP 请求上下文读取 `X-Omni-Module` 请求头。
pub fn request_omni_module_scope(context: &RequestContext<RoleServer>) -> OmniModuleScope {
    let raw = context
        .extensions
        .get::<Parts>()
        .and_then(|parts| parts.headers.get(X_OMNI_MODULE_HEADER))
        .and_then(|value| value.to_str().ok());
    parse_omni_module_header(raw)
}

/// 按模块头与 DB 可用性过滤工具列表。
pub fn filter_tools_for_request(
    tools: Vec<Tool>,
    scope: &OmniModuleScope,
    is_available: impl Fn(&str) -> bool,
) -> Vec<Tool> {
    match scope {
        OmniModuleScope::Unspecified => Vec::new(),
        OmniModuleScope::All => tools
            .into_iter()
            .filter(|tool| is_available(tool.name.as_ref()))
            .collect(),
        OmniModuleScope::Module(module) => tools
            .into_iter()
            .filter(|tool| {
                let name = tool.name.as_ref();
                is_available(name) && omni_tool_module_key(name) == Some(module.as_str())
            })
            .collect(),
    }
}

/// 校验工具是否允许在当前模块上下文中调用。
pub fn ensure_tool_allowed_for_module(
    tool_name: &str,
    scope: &OmniModuleScope,
) -> Result<(), String> {
    match scope {
        OmniModuleScope::Unspecified => Err(
            "缺少 X-Omni-Module 请求头或值为空，无法调用 MCP 工具".to_string(),
        ),
        OmniModuleScope::All => Ok(()),
        OmniModuleScope::Module(module) => {
            let tool_module = omni_tool_module_key(tool_name).ok_or_else(|| {
                format!("工具 {tool_name} 不符合 omni_{{module}}_{{function}} 命名规范")
            })?;
            if tool_module != module.as_str() {
                return Err(format!(
                    "工具 {tool_name} 不属于模块 {module}（当前 X-Omni-Module 请求头）"
                ));
            }
            Ok(())
        }
    }
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
            &OmniModuleScope::Module("database".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("knowledge"));
        assert!(err.contains("database"));
    }

    #[test]
    fn ensure_module_rejects_unspecified() {
        let err = ensure_tool_allowed_for_module(
            "omni_knowledge_create_document",
            &OmniModuleScope::Unspecified,
        )
        .unwrap_err();
        assert!(err.contains("X-Omni-Module"));
    }

    #[test]
    fn filter_tools_by_module() {
        let schema = std::sync::Arc::new(serde_json::Map::new());
        let tools = vec![
            Tool::new("omni_knowledge_create_document", "k", schema.clone()),
            Tool::new("omni_database_execute_sql", "d", schema),
        ];
        let filtered = filter_tools_for_request(
            tools,
            &OmniModuleScope::Module("knowledge".to_string()),
            |_| true,
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name.as_ref(), "omni_knowledge_create_document");
    }

    #[test]
    fn missing_or_empty_header_returns_no_tools() {
        let schema = std::sync::Arc::new(serde_json::Map::new());
        let tools = vec![Tool::new("omni_knowledge_create_document", "k", schema.clone())];

        assert!(filter_tools_for_request(
            tools.clone(),
            &parse_omni_module_header(None),
            |_| true,
        )
        .is_empty());
        assert!(filter_tools_for_request(
            tools.clone(),
            &parse_omni_module_header(Some("")),
            |_| true,
        )
        .is_empty());
        assert!(filter_tools_for_request(
            tools.clone(),
            &parse_omni_module_header(Some("   ")),
            |_| true,
        )
        .is_empty());
    }

    #[test]
    fn master_header_means_all_tools() {
        assert_eq!(
            parse_omni_module_header(None),
            OmniModuleScope::Unspecified
        );
        assert_eq!(
            parse_omni_module_header(Some("")),
            OmniModuleScope::Unspecified
        );
        assert_eq!(
            parse_omni_module_header(Some("master")),
            OmniModuleScope::All
        );
        assert_eq!(
            parse_omni_module_header(Some("MASTER")),
            OmniModuleScope::All
        );
        assert_eq!(
            parse_omni_module_header(Some("database")),
            OmniModuleScope::Module("database".to_string())
        );
    }
}
