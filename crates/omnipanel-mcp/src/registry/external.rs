//! 外部 MCP 服务工具在内部编排中的命名与解析。

const PREFIX: &str = "extmcp::";
const SEP: &str = "::";

/// 生成内部编排使用的工具名：`extmcp::{service_id}::{tool_name}`。
pub fn registry_tool_name(service_id: &str, tool_name: &str) -> String {
    format!("{PREFIX}{service_id}{SEP}{tool_name}")
}

/// 解析 `extmcp::{service_id}::{tool_name}`，service_id 与 tool_name 均不得含 `::`。
pub fn parse_registry_tool_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix(PREFIX)?;
    let (service_id, tool_name) = rest.rsplit_once(SEP)?;
    if service_id.is_empty() || tool_name.is_empty() {
        return None;
    }
    Some((service_id.to_string(), tool_name.to_string()))
}

pub fn is_external_mcp_registry_name(name: &str) -> bool {
    name.starts_with(PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_registry_name() {
        let name = registry_tool_name("mcp_123", "search");
        assert_eq!(name, "extmcp::mcp_123::search");
        assert_eq!(
            parse_registry_tool_name(&name),
            Some(("mcp_123".to_string(), "search".to_string()))
        );
    }

    #[test]
    fn builtin_omni_not_external() {
        assert!(!is_external_mcp_registry_name("omni_ssh_exec"));
    }
}
