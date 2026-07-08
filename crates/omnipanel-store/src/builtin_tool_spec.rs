//! 内置 AI 工具的单一真相源（后端权威定义）。
//!
//! 工具的名称 / 所属模块 / 描述 / 参数 schema / 执行类型全部集中在此，
//! 供以下各处共用，杜绝多处各写一份导致的漂移：
//! - `builtin_tools` 表种子与修复（`repair_builtin_tools`）
//! - `omnipanel-mcp` 的 ToolRegistry 装配（schema、执行类型）
//! - HTTP / ACP / OmniMCP 三条注入路径

/// 工具执行类型（与 omnipanel-mcp 的 `ToolExecutionKind` 一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecKind {
    /// 后端 Rust 直接执行（知识库、load_skill 等）。
    Native,
    /// 需要前端上下文执行（终端 / 数据库等），走 pending 回传通道。
    UiDelegated,
}

/// 内置工具规格。`input_schema` 为 JSON Schema 文本（object 结构）。
#[derive(Debug, Clone, Copy)]
pub struct BuiltinToolSpec {
    pub tool_name: &'static str,
    pub module_key: &'static str,
    pub description: &'static str,
    pub input_schema: &'static str,
    pub exec_kind: ToolExecKind,
    /// OmniMCP 对外暴露后是否可在后端直调（与内部 exec_kind 独立；终端/数据库内部仍走前端）。
    pub omnimcp_backend: bool,
}

const SCHEMA_TERMINAL_RUN: &str = r#"{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "要在当前活动终端会话中执行的 shell 命令，例如 date、ls -la。危险命令会进入用户确认流程。" },
    "session_id": { "type": "string", "description": "可选，指定终端 tab id；默认使用当前活动终端。" }
  },
  "required": ["command"]
}"#;

const SCHEMA_DB_GET_DATABASES: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "keyword": { "type": "string", "description": "可选，用于过滤结果的关键字（模糊匹配，忽略大小写）" }
  },
  "required": ["connection_name"]
}"#;

const SCHEMA_DB_GET_TABLES: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "database_name": { "type": "string", "description": "数据库名" },
    "keyword": { "type": "string", "description": "可选，用于过滤结果的关键字（模糊匹配，忽略大小写）" }
  },
  "required": ["connection_name", "database_name"]
}"#;

const SCHEMA_DB_TABLE_INFO: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "database_name": { "type": "string", "description": "数据库名" },
    "table_name": { "type": "string", "description": "表名" }
  },
  "required": ["connection_name", "database_name", "table_name"]
}"#;

const SCHEMA_DB_EXECUTE_SQL: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "database_name": { "type": "string", "description": "数据库名" },
    "sql": { "type": "string", "description": "要执行的 SQL 语句。SELECT 最多返回 500 行；DML 返回影响行数。" }
  },
  "required": ["connection_name", "database_name", "sql"]
}"#;

const SCHEMA_KNOWLEDGE_CREATE: &str = r#"{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "content": { "type": "string" },
    "kind": { "type": "string" },
    "tags": { "type": "string" },
    "source": { "type": "string" },
    "env_tag": { "type": "string" },
    "risk_level": { "type": "string" },
    "parent_id": { "type": "string" }
  },
  "required": ["title", "content"]
}"#;

const SCHEMA_KNOWLEDGE_REMOVE: &str = r#"{
  "type": "object",
  "properties": {
    "id": { "type": "string" }
  },
  "required": ["id"]
}"#;

const SCHEMA_KNOWLEDGE_LIST: &str = r#"{
  "type": "object",
  "properties": {
    "kind": { "type": "string" },
    "tag": { "type": "string" }
  }
}"#;

const SCHEMA_LIST_CONNECTIONS: &str = r#"{
  "type": "object",
  "properties": {
    "keyword": { "type": "string", "description": "可选，按连接名称关键字过滤（忽略大小写）" }
  }
}"#;

const SCHEMA_LOAD_SKILL: &str = r#"{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Skill 的 name 或 id（见系统提示中的 Skills 列表）" }
  },
  "required": ["name"]
}"#;

const SCHEMA_WEB_SEARCH: &str = r#"{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "搜索关键词或自然语言问题" },
    "max_results": { "type": "integer", "description": "最多返回条数，默认 10，全网上限 20" },
    "scope": {
      "type": "string",
      "enum": ["web", "zhihu"],
      "default": "web",
      "description": "web=全网搜索(默认,自动降级); zhihu=仅知乎站内"
    }
  },
  "required": ["query"]
}"#;

const SCHEMA_ZHIHU_SEARCH: &str = r#"{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "搜索关键词或自然语言问题" },
    "max_results": { "type": "integer", "description": "最多返回条数，默认 10，上限 10" }
  },
  "required": ["query"]
}"#;

const SCHEMA_WEB_FETCH: &str = r#"{
  "type": "object",
  "properties": {
    "url": { "type": "string", "description": "要抓取的网页 URL" },
    "format": {
      "type": "string",
      "enum": ["markdown", "text", "html"],
      "description": "返回格式，默认 markdown"
    }
  },
  "required": ["url"]
}"#;

/// 全部内置工具规格（单一真相源）。
pub const BUILTIN_TOOL_SPECS: &[BuiltinToolSpec] = &[
    BuiltinToolSpec {
        tool_name: "omni_ssh_list_connections",
        module_key: "ssh",
        description: "列出已保存的 SSH 连接（不含凭据与完整 config），供外部 Agent 选择目标主机。",
        input_schema: SCHEMA_LIST_CONNECTIONS,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_terminal_run_terminal_command",
        module_key: "terminal",
        description: "在当前活动终端会话中执行 shell 命令。危险命令会进入用户确认流程；执行完成后返回退出码与输出。",
        input_schema: SCHEMA_TERMINAL_RUN,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_list_connections",
        module_key: "database",
        description: "列出已保存的数据库连接（不含密码等敏感字段），供外部 Agent 选择 connection_name。",
        input_schema: SCHEMA_LIST_CONNECTIONS,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_get_databases_from_connection",
        module_key: "database",
        description: "根据连接名获取该连接下的数据库列表，可选关键字过滤。",
        input_schema: SCHEMA_DB_GET_DATABASES,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_get_tables_from_database",
        module_key: "database",
        description: "根据连接名和数据库名获取表列表，可选关键字过滤。",
        input_schema: SCHEMA_DB_GET_TABLES,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_get_table_info",
        module_key: "database",
        description: "根据连接名、数据库名和表名获取表结构信息（MySQL/MariaDB 执行 DESC，其他引擎使用 introspect）。",
        input_schema: SCHEMA_DB_TABLE_INFO,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_execute_sql",
        module_key: "database",
        description: "在指定连接和数据库上执行 SQL。SELECT 结果最多返回 500 行；DML 返回影响行数。",
        input_schema: SCHEMA_DB_EXECUTE_SQL,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_knowledge_create_document",
        module_key: "knowledge",
        description: "在知识库中创建文档。",
        input_schema: SCHEMA_KNOWLEDGE_CREATE,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_knowledge_remove_document",
        module_key: "knowledge",
        description: "按 ID 删除知识库文档。",
        input_schema: SCHEMA_KNOWLEDGE_REMOVE,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_knowledge_list_documents",
        module_key: "knowledge",
        description: "列出知识库文档，可按类型或标签过滤。",
        input_schema: SCHEMA_KNOWLEDGE_LIST,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "load_skill",
        module_key: "knowledge",
        description: "加载指定 Skill 的完整 SKILL.md 正文（渐进式披露）",
        input_schema: SCHEMA_LOAD_SKILL,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_web_search",
        module_key: "web",
        description: "全网搜索，默认 scope=web。涉及中文经验/讨论/评测类问题，或全网结果不满意时，可改用 omni_zhihu_search 穿插补充。",
        input_schema: SCHEMA_WEB_SEARCH,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_zhihu_search",
        module_key: "web",
        description: "知乎站内搜索(问题/回答/文章/用户)，适合中文知识、经验、讨论、评测类问题，或全网结果不足时补充。",
        input_schema: SCHEMA_ZHIHU_SEARCH,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_web_fetch",
        module_key: "web",
        description: "抓取指定 URL 的网页正文（默认本地直连转 Markdown，失败时降级 Jina Reader）。",
        input_schema: SCHEMA_WEB_FETCH,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
];

/// 按工具名查找 spec。
pub fn builtin_tool_spec(tool_name: &str) -> Option<&'static BuiltinToolSpec> {
    BUILTIN_TOOL_SPECS.iter().find(|s| s.tool_name == tool_name)
}

/// 按工具名查找 spec 的 module_key（含 `load_skill` 等非 omni_ 前缀工具）。
pub fn builtin_tool_module_key(tool_name: &str) -> Option<&'static str> {
    builtin_tool_spec(tool_name).map(|s| s.module_key)
}

/// 工具是否为后端直执（Native）。未知工具视为非 Native。
pub fn builtin_tool_is_native(tool_name: &str) -> bool {
    builtin_tool_spec(tool_name).is_some_and(|s| s.exec_kind == ToolExecKind::Native)
}

/// OmniMCP 对外暴露后是否可在后端直调。
pub fn builtin_tool_omnimcp_backend(tool_name: &str) -> bool {
    builtin_tool_spec(tool_name).is_some_and(|s| s.omnimcp_backend)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_schema_is_valid_json_object() {
        for spec in BUILTIN_TOOL_SPECS {
            let v: serde_json::Value = serde_json::from_str(spec.input_schema)
                .unwrap_or_else(|e| panic!("{} schema 非法: {e}", spec.tool_name));
            assert_eq!(
                v.get("type").and_then(|t| t.as_str()),
                Some("object"),
                "{} schema 顶层 type 必须为 object",
                spec.tool_name
            );
        }
    }

    #[test]
    fn terminal_tool_requires_command() {
        let spec = builtin_tool_spec("omni_terminal_run_terminal_command").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("command")));
        assert_eq!(spec.exec_kind, ToolExecKind::UiDelegated);
    }

    #[test]
    fn knowledge_and_load_skill_are_native() {
        assert!(builtin_tool_is_native("omni_knowledge_create_document"));
        assert!(builtin_tool_is_native("load_skill"));
        assert!(builtin_tool_is_native("omni_database_list_connections"));
        assert!(!builtin_tool_is_native("omni_terminal_run_terminal_command"));
    }

    #[test]
    fn load_skill_module_key_from_spec() {
        assert_eq!(builtin_tool_module_key("load_skill"), Some("knowledge"));
        assert_eq!(
            builtin_tool_module_key("omni_ssh_list_connections"),
            Some("ssh")
        );
    }
}
