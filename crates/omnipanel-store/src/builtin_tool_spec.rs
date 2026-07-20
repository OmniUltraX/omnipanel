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

const SCHEMA_DB_SHOW_PROCESSLIST: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "database_name": { "type": "string", "description": "可选，指定数据库上下文（部分引擎需要切换到对应库才能查询元数据视图）" }
  },
  "required": ["connection_name"]
}"#;

const SCHEMA_DB_KILL_QUERY: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "query_id": { "type": "string", "description": "要终止的会话/查询 ID（MySQL/MariaDB 为 PROCESSLIST_ID 数字，PostgreSQL 为 pid 数字，Redis 为客户端地址 ip:port）" }
  },
  "required": ["connection_name", "query_id"]
}"#;

const SCHEMA_DB_SLOW_LOG_SUMMARY: &str = r#"{
  "type": "object",
  "properties": {
    "connection_name": { "type": "string", "description": "数据库连接名称（与侧栏连接名一致）" },
    "database_name": { "type": "string", "description": "可选，指定数据库上下文" },
    "count": { "type": "integer", "description": "返回的记录数量上限，默认 10，范围 1~100", "default": 10, "minimum": 1, "maximum": 100 }
  },
  "required": ["connection_name"]
}"#;

const SCHEMA_RESOURCE_GET_PROFILE: &str = r#"{
  "type": "object",
  "properties": {
    "resource_type": { "type": "string", "description": "资源类型：ssh / database / docker / files", "enum": ["ssh", "database", "docker", "files"] },
    "resource_id": { "type": "string", "description": "资源标识（SSH 为主机名/连接名；database 为连接名；docker 为容器 id 或连接名）" }
  },
  "required": ["resource_type", "resource_id"]
}"#;

const SCHEMA_RESOURCE_FIND_SIMILAR: &str = r#"{
  "type": "object",
  "properties": {
    "resource_type": { "type": "string", "description": "资源类型：ssh / database / docker / files", "enum": ["ssh", "database", "docker", "files"] },
    "resource_id": { "type": "string", "description": "参考资源标识（基于其指纹查找相似资源）" },
    "limit": { "type": "integer", "description": "返回的最大相似资源数量，默认 5", "default": 5, "minimum": 1, "maximum": 20 }
  },
  "required": ["resource_type", "resource_id"]
}"#;

const SCHEMA_RESOURCE_UPDATE_PROFILE: &str = r#"{
  "type": "object",
  "properties": {
    "resource_type": { "type": "string", "description": "资源类型：ssh / database / docker / files", "enum": ["ssh", "database", "docker", "files"] },
    "resource_id": { "type": "string", "description": "资源标识" },
    "observation_kind": { "type": "string", "description": "观测种类：hardware / services / topology / key_paths / overview / schema_summary / table_relations / index_health / users / note" },
    "payload": { "type": "object", "description": "观测负载（自由结构 JSON 对象）" },
    "observer": { "type": "string", "description": "观测来源：auto（采集器）/ manual（用户录入）/ ai（AI 工具更新）", "default": "ai", "enum": ["auto", "manual", "ai"] }
  },
  "required": ["resource_type", "resource_id", "observation_kind", "payload"]
}"#;

const SCHEMA_SKILL_RECALL: &str = r#"{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "自然语言查询（当前任务/问题描述），用于匹配相关 skill" },
    "resource_type": { "type": "string", "description": "可选，资源类型过滤（ssh / database / docker / files），只召回关联该类型的 skill" },
    "top_k": { "type": "integer", "description": "返回的最大 skill 数量，默认 3", "default": 3, "minimum": 1, "maximum": 10 }
  },
  "required": ["query"]
}"#;

const SCHEMA_SKILL_REPORT_OUTCOME: &str = r#"{
  "type": "object",
  "properties": {
    "application_id": { "type": "string", "description": "omni_skill_recall 返回的 application_id" },
    "outcome": { "type": "string", "description": "应用结果", "enum": ["success", "failure", "partial", "pending"] },
    "feedback": { "type": "string", "description": "可选，结果说明（失败原因、适用差异等）" }
  },
  "required": ["application_id", "outcome"]
}"#;

const SCHEMA_SKILL_EXTRACT_EXPERIENCE: &str = r#"{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "skill 标题（简短，如「磁盘清理 - Linux 大文件定位」）" },
    "description": { "type": "string", "description": "一句话描述 skill 的适用场景" },
    "body": { "type": "string", "description": "skill 正文（Markdown），包含步骤/命令/注意事项等完整经验" },
    "resource_type": { "type": "string", "description": "可选，关联资源类型", "enum": ["ssh", "database", "docker", "files", ""] },
    "resource_id": { "type": "string", "description": "可选，关联资源标识（如主机名/连接名）" },
    "knowledge_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "可选，关联的 knowledge 条目 id 列表（case 文档/笔记等）"
    },
    "parent_skill_id": { "type": "string", "description": "可选，如果是对已有 skill 的改进，传入原 skill id（会创建新版本）" }
  },
  "required": ["title", "description", "body"]
}"#;

const SCHEMA_SKILL_REFINE: &str = r#"{
  "type": "object",
  "properties": {
    "skill_id": { "type": "string", "description": "要改进的 skill id（将基于其内容创建新版本，原版本 enabled 置为 false）" },
    "improvements": { "type": "string", "description": "改进说明（AI 生成的 diff 描述，说明改了什么、为什么改）" },
    "new_body": { "type": "string", "description": "改进后的完整 skill 正文（Markdown）" },
    "new_description": { "type": "string", "description": "可选，更新后的描述；不传则沿用原描述" }
  },
  "required": ["skill_id", "improvements", "new_body"]
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

const SCHEMA_SSH_EXEC: &str = r#"{
  "type": "object",
  "properties": {
    "resource_id": { "type": "string", "description": "SSH 主机连接 id（可先用 omni_ssh_list_connections 查询）" },
    "command": { "type": "string", "description": "要在远程主机上执行的非交互式 shell 命令。不支持 TUI/流式命令（如 top、vim、tail -f），请用 top -bn1 | head / tail -n 100 等替代。" }
  },
  "required": ["resource_id", "command"]
}"#;

const SCHEMA_SSH_GET_STATS: &str = r#"{
  "type": "object",
  "properties": {
    "resource_id": { "type": "string", "description": "SSH 主机连接 id（可先用 omni_ssh_list_connections 查询）" }
  },
  "required": ["resource_id"]
}"#;

const SCHEMA_SSH_LIST_TUNNELS: &str = r#"{
  "type": "object",
  "properties": {}
}"#;

const SCHEMA_SSH_CREATE_TUNNEL: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "SSH 主机连接 id（可先用 omni_ssh_list_connections 查询）" },
    "tunnel_type": {
      "type": "string",
      "enum": ["local", "remote", "dynamic"],
      "description": "隧道类型：local=本地端口转发到远程；remote=远程端口转发到本地；dynamic=SOCKS 动态代理"
    },
    "local_port": { "type": "integer", "description": "本地监听端口" },
    "remote_host": { "type": "string", "description": "目标主机（dynamic 类型可省略）" },
    "remote_port": { "type": "integer", "description": "目标端口（dynamic 类型可省略）" }
  },
  "required": ["connection_id", "tunnel_type", "local_port"]
}"#;

const SCHEMA_WORKSPACE_CREATE: &str = r#"{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "工作区名称" },
    "description": { "type": "string", "description": "可选描述" },
    "resource_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "可选，纳入的连接/资源 id 列表"
    }
  },
  "required": ["name"]
}"#;

const SCHEMA_WORKSPACE_ID: &str = r#"{
  "type": "object",
  "properties": {
    "workspace_id": { "type": "string", "description": "工作区 id" }
  },
  "required": ["workspace_id"]
}"#;

const SCHEMA_WORKSPACE_LIST: &str = r#"{
  "type": "object",
  "properties": {
    "workspace_id": { "type": "string", "description": "可选；省略=全局资源" }
  }
}"#;

const SCHEMA_WORKSPACE_MEMBERSHIP: &str = r#"{
  "type": "object",
  "properties": {
    "workspace_id": { "type": "string" },
    "resource_ids": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["workspace_id", "resource_ids"]
}"#;

const SCHEMA_SSH_FLEET_HEALTH: &str = r#"{
  "type": "object",
  "properties": {
    "workspace_id": { "type": "string", "description": "可选；限定工作区。省略=会话钉住或全局" }
  }
}"#;

const SCHEMA_DOCKER_LIST_CONTAINERS: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "Docker 连接 id；本地 Engine 用 'docker-local'，可先用 omni_docker_list_connections 查询" },
    "filter": {
      "type": "string",
      "enum": ["all", "running", "stopped"],
      "description": "容器筛选，默认 all"
    }
  },
  "required": ["connection_id"]
}"#;

const SCHEMA_DOCKER_CONTAINER_LOGS: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "Docker 连接 id" },
    "container_id": { "type": "string", "description": "容器 id 或名称" },
    "tail": { "type": "integer", "description": "返回最后 N 行，默认 200" },
    "since": { "type": "string", "description": "可选时间范围：'all' / 相对时长（'15m'、'1h'、'24h'）/ RFC3339" }
  },
  "required": ["connection_id", "container_id"]
}"#;

const SCHEMA_DOCKER_INSPECT: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "Docker 连接 id" },
    "container_id": { "type": "string", "description": "容器 id 或名称" }
  },
  "required": ["connection_id", "container_id"]
}"#;

const SCHEMA_DOCKER_CONTAINER_ACTION: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "Docker 连接 id" },
    "container_id": { "type": "string", "description": "容器 id 或名称" },
    "action": {
      "type": "string",
      "enum": ["start", "stop", "restart", "kill", "pause", "unpause", "remove"],
      "description": "生命周期动作；kill/remove 为危险动作，需用户确认"
    }
  },
  "required": ["connection_id", "container_id", "action"]
}"#;

const SCHEMA_DOCKER_EXEC: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "Docker 连接 id" },
    "container_id": { "type": "string", "description": "容器 id 或名称" },
    "command": { "type": "string", "description": "要在容器内执行的非交互命令（单条；不支持 ; / && / || 复合命令）" }
  },
  "required": ["connection_id", "container_id", "command"]
}"#;

const SCHEMA_DOCKER_LIST_CONNECTIONS: &str = r#"{
  "type": "object",
  "properties": {}
}"#;

const SCHEMA_FILES_LIST_CONNECTIONS: &str = r#"{
  "type": "object",
  "properties": {}
}"#;

const SCHEMA_FILES_LIST: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "文件连接 id；本机用 '__local__'，可先用 omni_files_list_connections 查询" },
    "path": { "type": "string", "description": "目录绝对路径；本机空串或 '/' 表示用户主目录，'\\\\' 表示 Windows 此电脑根" },
    "search": { "type": "string", "description": "可选，按文件名子串过滤（忽略大小写）" }
  },
  "required": ["connection_id", "path"]
}"#;

const SCHEMA_FILES_READ: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "文件连接 id；本机用 '__local__'" },
    "path": { "type": "string", "description": "文件绝对路径" },
    "max_bytes": { "type": "integer", "description": "最多读取字节数，默认 524288（512KB），上限 8388608（8MB）" }
  },
  "required": ["connection_id", "path"]
}"#;

const SCHEMA_FILES_WRITE: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "文件连接 id；本机用 '__local__'" },
    "path": { "type": "string", "description": "文件绝对路径；父目录不存在会自动创建" },
    "content": { "type": "string", "description": "要写入的文本内容（UTF-8），将完整覆盖原文件" },
    "append": { "type": "boolean", "description": "可选，true=追加到文件末尾，false/默认=覆盖" }
  },
  "required": ["connection_id", "path", "content"]
}"#;

const SCHEMA_FILES_SEARCH: &str = r#"{
  "type": "object",
  "properties": {
    "connection_id": { "type": "string", "description": "文件连接 id；本机用 '__local__'" },
    "query": { "type": "string", "description": "搜索关键词（文件名子串，忽略大小写）。S3 协议下含 '/' 时按 key 前缀查询" },
    "path": { "type": "string", "description": "可选，搜索起始目录；默认为连接根路径" }
  },
  "required": ["connection_id", "query"]
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
        tool_name: "omni_ssh_exec",
        module_key: "ssh",
        description:
            "在指定 SSH 主机上非交互式执行 shell 命令，返回 stdout/stderr/exit_code。\
             危险命令同样进入用户确认流程。不支持 TUI/流式命令（top/vim/tail -f）。",
        input_schema: SCHEMA_SSH_EXEC,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_ssh_get_stats",
        module_key: "ssh",
        description:
            "拉取指定 SSH 主机的实时系统指标快照（CPU/内存/磁盘/网络/负载/运行时长/OS 信息）。",
        input_schema: SCHEMA_SSH_GET_STATS,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_ssh_list_tunnels",
        module_key: "ssh",
        description: "列出当前所有 SSH 隧道（端口转发）及其状态。",
        input_schema: SCHEMA_SSH_LIST_TUNNELS,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_ssh_create_tunnel",
        module_key: "ssh",
        description:
            "在指定 SSH 连接上创建端口转发隧道（local/remote/dynamic）。\
             dynamic 类型为 SOCKS 代理，可省略 remote_host/remote_port。",
        input_schema: SCHEMA_SSH_CREATE_TUNNEL,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_docker_list_connections",
        module_key: "docker",
        description:
            "列出已保存的 Docker 连接（含本地 Engine / 远程 Engine / SSH Engine / 1Panel），\
             供外部 Agent 选择目标。本地 Engine 的 connection_id 固定为 'docker-local'。",
        input_schema: SCHEMA_DOCKER_LIST_CONNECTIONS,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_docker_list_containers",
        module_key: "docker",
        description:
            "列出指定 Docker 连接下的容器（id/name/image/state/ports/networks）。\
             filter 支持 all / running / stopped，默认 all。",
        input_schema: SCHEMA_DOCKER_LIST_CONTAINERS,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_docker_container_logs",
        module_key: "docker",
        description:
            "拉取容器最近日志（默认 tail=200），可选 since 时间范围。\
             返回 {stream, message} 数组。",
        input_schema: SCHEMA_DOCKER_CONTAINER_LOGS,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_docker_inspect_container",
        module_key: "docker",
        description:
            "查看容器详情（command/restart_policy/exit_code/env/mounts/networks 等）。\
             仅 Local / Remote / SSH Engine 支持；1Panel 不支持。",
        input_schema: SCHEMA_DOCKER_INSPECT,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_docker_container_action",
        module_key: "docker",
        description:
            "对容器执行生命周期动作（start/stop/restart/kill/pause/unpause/remove）。\
             kill/remove 为危险动作，需用户确认。",
        input_schema: SCHEMA_DOCKER_CONTAINER_ACTION,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_docker_exec",
        module_key: "docker",
        description:
            "在容器内执行非交互式命令（单条；不支持 ; / && / || 复合命令），返回 stdout/stderr/exit_code。\
             1Panel 不支持此工具。",
        input_schema: SCHEMA_DOCKER_EXEC,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_files_list_connections",
        module_key: "files",
        description:
            "列出已保存的文件管理器连接（含本机 / SFTP / FTP / S3）。本机连接 id 固定为 '__local__'。",
        input_schema: SCHEMA_FILES_LIST_CONNECTIONS,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_files_list",
        module_key: "files",
        description:
            "列出指定目录下的文件与子目录（含大小/修改时间/权限）。可选 search 按文件名子串过滤。\
             本机空 path 表示用户主目录；Windows '\\\\' 表示此电脑根（盘符列表）。",
        input_schema: SCHEMA_FILES_LIST,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_files_read",
        module_key: "files",
        description:
            "读取文件文本内容（UTF-8）。默认上限 512KB，最大 8MB。\
             二进制文件会被解码为 UTF-8 替换字符（不影响 AI 阅读文本配置/日志）。",
        input_schema: SCHEMA_FILES_READ,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_files_write",
        module_key: "files",
        description:
            "将文本内容写入文件（默认覆盖；append=true 追加）。父目录不存在会自动创建。\
             危险动作（覆盖关键系统文件）需用户确认。",
        input_schema: SCHEMA_FILES_WRITE,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_files_search",
        module_key: "files",
        description:
            "按文件名子串搜索（忽略大小写）。S3 协议下含 '/' 时按 key 前缀查询。\
             仅返回当前目录一层匹配项，不递归（递归搜索请配合 SSH find / grep）。",
        input_schema: SCHEMA_FILES_SEARCH,
        exec_kind: ToolExecKind::UiDelegated,
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
        tool_name: "omni_database_show_processlist",
        module_key: "database",
        description: "查看数据库当前会话/进程列表（MySQL/MariaDB 查 information_schema.PROCESSLIST；PostgreSQL 查 pg_stat_activity；Redis 执行 CLIENT LIST），用于排查长运行查询、锁等待。",
        input_schema: SCHEMA_DB_SHOW_PROCESSLIST,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_kill_query",
        module_key: "database",
        description: "终止指定会话/查询（MySQL/MariaDB 执行 KILL；PostgreSQL 调用 pg_terminate_backend；Redis 执行 CLIENT KILL ADDR）。危险操作，请确认 query_id 正确。",
        input_schema: SCHEMA_DB_KILL_QUERY,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_database_slow_log_summary",
        module_key: "database",
        description: "汇总慢查询日志（MySQL/MariaDB 查 mysql.slow_log 或 performance_schema；PostgreSQL 查 pg_stat_statements；Redis 执行 SLOWLOG GET），用于性能优化分析。",
        input_schema: SCHEMA_DB_SLOW_LOG_SUMMARY,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_resource_get_profile",
        module_key: "knowledge",
        description: "获取资源档案：返回指定资源（SSH 主机 / 数据库连接等）的最新观测快照（hardware / services / overview / schema_summary 等各类最新一条）。供 AI 在处理新问题时快速了解资源历史状态。",
        input_schema: SCHEMA_RESOURCE_GET_PROFILE,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_resource_find_similar",
        module_key: "knowledge",
        description: "查找相似资源（指纹匹配），并附带 related_skills（同类型经验 Skill）。用于『p4 解决后在 p7 复用』；若 skill 不足可再调 omni_skill_recall。",
        input_schema: SCHEMA_RESOURCE_FIND_SIMILAR,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_resource_update_profile",
        module_key: "knowledge",
        description: "更新资源档案：手动或由 AI 追加一条观测记录（如部署服务清单、已知问题、运维笔记等）。不会覆盖历史，append-only。",
        input_schema: SCHEMA_RESOURCE_UPDATE_PROFILE,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_skill_recall",
        module_key: "knowledge",
        description:
            "召回相关 skill：混合向量检索 + 关键词匹配已启用的 skill，返回正文与 application_id。\
             应用后务必调用 omni_skill_report_outcome 回写 success/failure。",
        input_schema: SCHEMA_SKILL_RECALL,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_skill_extract_experience",
        module_key: "knowledge",
        description:
            "从完成的任务中提取经验并创建 skill：生成 SKILL.md，可选关联资源/knowledge，\
             并 best-effort 向量化以便后续召回。支持 parent_skill_id 创建新版本。",
        input_schema: SCHEMA_SKILL_EXTRACT_EXPERIENCE,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_skill_refine",
        module_key: "knowledge",
        description:
            "改进已有 skill：基于应用反馈创建新版本（原版本 enabled=0），复制 knowledge 关联并向量化。",
        input_schema: SCHEMA_SKILL_REFINE,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_skill_report_outcome",
        module_key: "knowledge",
        description:
            "回写 skill 应用结果（success/failure/partial），更新成功率统计。\
             在按 skill 完成任务后调用；application_id 来自 omni_skill_recall。",
        input_schema: SCHEMA_SKILL_REPORT_OUTCOME,
        exec_kind: ToolExecKind::Native,
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
        description: "联网搜索公开网页信息；query 宜具体可检索。默认 scope=web，中文讨论可改 zhihu 或 omni_zhihu_search。",
        input_schema: SCHEMA_WEB_SEARCH,
        exec_kind: ToolExecKind::Native,
        omnimcp_backend: true,
    },
    BuiltinToolSpec {
        tool_name: "omni_zhihu_search",
        module_key: "web",
        description: "知乎站内搜索(问题/回答/文章/用户)，适合中文经验、讨论与评测类问题。",
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
    BuiltinToolSpec {
        tool_name: "omni_workspace_create",
        module_key: "ssh",
        description:
            "创建业务工作区（可选纳入 resource_ids）。工作区非必选；仅当用户明确要求隔离/整理时调用。",
        input_schema: SCHEMA_WORKSPACE_CREATE,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: false,
    },
    BuiltinToolSpec {
        tool_name: "omni_workspace_switch",
        module_key: "ssh",
        description: "切换到指定工作区（UI）。",
        input_schema: SCHEMA_WORKSPACE_ID,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: false,
    },
    BuiltinToolSpec {
        tool_name: "omni_workspace_list_resources",
        module_key: "ssh",
        description: "列出资源。不传 workspace_id 时返回全局连接；传入时返回该工作区 membership。",
        input_schema: SCHEMA_WORKSPACE_LIST,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: false,
    },
    BuiltinToolSpec {
        tool_name: "omni_workspace_add_resources",
        module_key: "ssh",
        description: "将资源 id 纳入指定工作区 membership。",
        input_schema: SCHEMA_WORKSPACE_MEMBERSHIP,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: false,
    },
    BuiltinToolSpec {
        tool_name: "omni_workspace_remove_resources",
        module_key: "ssh",
        description: "从工作区 membership 移除资源。",
        input_schema: SCHEMA_WORKSPACE_MEMBERSHIP,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: false,
    },
    BuiltinToolSpec {
        tool_name: "omni_orchestration_ssh_fleet_health",
        module_key: "ssh",
        description:
            "对全部（或指定工作区内）SSH 主机扇出采集资源占用，返回汇总供优化建议。\
             适合「给所有 SSH 做体检」；会显示任务进度。",
        input_schema: SCHEMA_SSH_FLEET_HEALTH,
        exec_kind: ToolExecKind::UiDelegated,
        omnimcp_backend: false,
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

    #[test]
    fn ssh_tools_registered_as_ui_delegated() {
        // list_connections 是 Native（仅查表），其余 ssh 工具都需要前端/连接池执行
        assert!(builtin_tool_is_native("omni_ssh_list_connections"));
        for name in [
            "omni_ssh_exec",
            "omni_ssh_get_stats",
            "omni_ssh_list_tunnels",
            "omni_ssh_create_tunnel",
        ] {
            let spec = builtin_tool_spec(name).unwrap_or_else(|| panic!("{name} 未注册"));
            assert_eq!(spec.exec_kind, ToolExecKind::UiDelegated, "{name}");
            assert_eq!(spec.module_key, "ssh", "{name}");
            assert!(spec.omnimcp_backend, "{name}");
        }
    }

    #[test]
    fn ssh_exec_schema_requires_resource_id_and_command() {
        let spec = builtin_tool_spec("omni_ssh_exec").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("resource_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("command")));
    }

    #[test]
    fn ssh_create_tunnel_schema_supports_dynamic_type() {
        let spec = builtin_tool_spec("omni_ssh_create_tunnel").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let enum_values: Vec<&str> = v["properties"]["tunnel_type"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert!(enum_values.contains(&"local"));
        assert!(enum_values.contains(&"remote"));
        assert!(enum_values.contains(&"dynamic"));
    }

    #[test]
    fn docker_tools_registered_with_correct_exec_kind() {
        // list_connections 是 Native（仅查表），其余 docker 工具都需要前端/adapter 执行
        assert!(builtin_tool_is_native("omni_docker_list_connections"));
        for name in [
            "omni_docker_list_containers",
            "omni_docker_container_logs",
            "omni_docker_inspect_container",
            "omni_docker_container_action",
            "omni_docker_exec",
        ] {
            let spec = builtin_tool_spec(name).unwrap_or_else(|| panic!("{name} 未注册"));
            assert_eq!(spec.exec_kind, ToolExecKind::UiDelegated, "{name}");
            assert_eq!(spec.module_key, "docker", "{name}");
            assert!(spec.omnimcp_backend, "{name}");
        }
    }

    #[test]
    fn docker_list_containers_schema_requires_connection_id() {
        let spec = builtin_tool_spec("omni_docker_list_containers").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        // filter 应当是可选枚举
        assert!(!required.iter().any(|x| x.as_str() == Some("filter")));
        let enum_values: Vec<&str> = v["properties"]["filter"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert!(enum_values.contains(&"all"));
        assert!(enum_values.contains(&"running"));
        assert!(enum_values.contains(&"stopped"));
    }

    #[test]
    fn docker_container_action_schema_supports_restart_and_remove() {
        let spec = builtin_tool_spec("omni_docker_container_action").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let enum_values: Vec<&str> = v["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert!(enum_values.contains(&"start"));
        assert!(enum_values.contains(&"stop"));
        assert!(enum_values.contains(&"restart"));
        assert!(enum_values.contains(&"kill"));
        assert!(enum_values.contains(&"remove"));
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("container_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("action")));
    }

    #[test]
    fn docker_exec_schema_requires_command() {
        let spec = builtin_tool_spec("omni_docker_exec").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("container_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("command")));
    }

    #[test]
    fn docker_container_logs_schema_tail_optional() {
        let spec = builtin_tool_spec("omni_docker_container_logs").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("container_id")));
        // tail 与 since 均为可选
        assert!(!required.iter().any(|x| x.as_str() == Some("tail")));
        assert!(!required.iter().any(|x| x.as_str() == Some("since")));
    }

    #[test]
    fn files_tools_registered_with_correct_exec_kind() {
        // list_connections 是 Native（仅查表），其余 files 工具都走前端 invoke Tauri 命令
        assert!(builtin_tool_is_native("omni_files_list_connections"));
        for name in [
            "omni_files_list",
            "omni_files_read",
            "omni_files_write",
            "omni_files_search",
        ] {
            let spec = builtin_tool_spec(name).unwrap_or_else(|| panic!("{name} 未注册"));
            assert_eq!(spec.exec_kind, ToolExecKind::UiDelegated, "{name}");
            assert_eq!(spec.module_key, "files", "{name}");
            assert!(spec.omnimcp_backend, "{name}");
        }
    }

    #[test]
    fn files_list_schema_requires_connection_id_and_path() {
        let spec = builtin_tool_spec("omni_files_list").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("path")));
        // search 应当是可选
        assert!(!required.iter().any(|x| x.as_str() == Some("search")));
    }

    #[test]
    fn files_read_schema_max_bytes_optional() {
        let spec = builtin_tool_spec("omni_files_read").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("path")));
        assert!(!required.iter().any(|x| x.as_str() == Some("max_bytes")));
    }

    #[test]
    fn files_write_schema_requires_content_and_supports_append() {
        let spec = builtin_tool_spec("omni_files_write").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("path")));
        assert!(required.iter().any(|x| x.as_str() == Some("content")));
        // append 应当是可选
        assert!(!required.iter().any(|x| x.as_str() == Some("append")));
        // append 是 boolean
        assert_eq!(
            v["properties"]["append"]["type"].as_str(),
            Some("boolean")
        );
    }

    #[test]
    fn files_search_schema_requires_query() {
        let spec = builtin_tool_spec("omni_files_search").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("query")));
        // path 应当是可选
        assert!(!required.iter().any(|x| x.as_str() == Some("path")));
    }

    #[test]
    fn database_supplementary_tools_registered_as_ui_delegated() {
        for name in [
            "omni_database_show_processlist",
            "omni_database_kill_query",
            "omni_database_slow_log_summary",
        ] {
            let spec = builtin_tool_spec(name).unwrap_or_else(|| panic!("{name} 未注册"));
            assert_eq!(spec.exec_kind, ToolExecKind::UiDelegated, "{name}");
            assert_eq!(spec.module_key, "database", "{name}");
            assert!(spec.omnimcp_backend, "{name}");
            assert!(!builtin_tool_is_native(name), "{name} 不应是 Native");
        }
    }

    #[test]
    fn database_show_processlist_schema_requires_only_connection_name() {
        let spec = builtin_tool_spec("omni_database_show_processlist").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_name")));
        // database_name 应当可选
        assert!(!required.iter().any(|x| x.as_str() == Some("database_name")));
    }

    #[test]
    fn database_kill_query_schema_requires_query_id_as_string() {
        let spec = builtin_tool_spec("omni_database_kill_query").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_name")));
        assert!(required.iter().any(|x| x.as_str() == Some("query_id")));
        // query_id 为 string（兼容 Redis addr 与数值 id）
        assert_eq!(v["properties"]["query_id"]["type"].as_str(), Some("string"));
    }

    #[test]
    fn database_slow_log_summary_count_optional_with_default() {
        let spec = builtin_tool_spec("omni_database_slow_log_summary").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("connection_name")));
        assert!(!required.iter().any(|x| x.as_str() == Some("count")));
        assert_eq!(v["properties"]["count"]["default"].as_i64(), Some(10));
    }

    #[test]
    fn resource_tools_registered_as_native() {
        // 资源档案工具全部为 Native（后端直查 storage），无需前端/连接池
        for name in [
            "omni_resource_get_profile",
            "omni_resource_find_similar",
            "omni_resource_update_profile",
        ] {
            let spec = builtin_tool_spec(name).unwrap_or_else(|| panic!("{name} 未注册"));
            assert_eq!(spec.exec_kind, ToolExecKind::Native, "{name}");
            assert_eq!(spec.module_key, "knowledge", "{name}");
            assert!(spec.omnimcp_backend, "{name}");
            assert!(builtin_tool_is_native(name), "{name} 应当是 Native");
        }
    }

    #[test]
    fn resource_get_profile_schema_requires_resource_type_and_id() {
        let spec = builtin_tool_spec("omni_resource_get_profile").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("resource_type")));
        assert!(required.iter().any(|x| x.as_str() == Some("resource_id")));
        // resource_type 应当是 enum
        let enum_values: Vec<&str> = v["properties"]["resource_type"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert!(enum_values.contains(&"ssh"));
        assert!(enum_values.contains(&"database"));
        assert!(enum_values.contains(&"docker"));
        assert!(enum_values.contains(&"files"));
    }

    #[test]
    fn resource_find_similar_schema_limit_optional_with_default() {
        let spec = builtin_tool_spec("omni_resource_find_similar").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("resource_type")));
        assert!(required.iter().any(|x| x.as_str() == Some("resource_id")));
        // limit 可选，默认 5
        assert!(!required.iter().any(|x| x.as_str() == Some("limit")));
        assert_eq!(v["properties"]["limit"]["default"].as_i64(), Some(5));
        assert_eq!(v["properties"]["limit"]["minimum"].as_i64(), Some(1));
        assert_eq!(v["properties"]["limit"]["maximum"].as_i64(), Some(20));
    }

    #[test]
    fn resource_update_profile_schema_requires_payload_and_kind() {
        let spec = builtin_tool_spec("omni_resource_update_profile").unwrap();
        let v: serde_json::Value = serde_json::from_str(spec.input_schema).unwrap();
        let required = v.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("resource_type")));
        assert!(required.iter().any(|x| x.as_str() == Some("resource_id")));
        assert!(required.iter().any(|x| x.as_str() == Some("observation_kind")));
        assert!(required.iter().any(|x| x.as_str() == Some("payload")));
        // observer 可选，默认 "ai"
        assert!(!required.iter().any(|x| x.as_str() == Some("observer")));
        assert_eq!(v["properties"]["observer"]["default"].as_str(), Some("ai"));
        // payload 类型为 object
        assert_eq!(v["properties"]["payload"]["type"].as_str(), Some("object"));
    }
}
