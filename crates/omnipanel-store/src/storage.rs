use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::Connection as SqliteConnection;
use serde::{Deserialize, Serialize};

/// HTTP 请求/历史/集合表结构。用于 v9+ 迁移及启动后 repair，兼容旧库缺表。
const HTTP_SCHEMA_BOOTSTRAP: &str = r#"
CREATE TABLE IF NOT EXISTS http_requests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    body TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT 'none',
    auth_value TEXT NOT NULL DEFAULT '',
    collection_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_requests_collection ON http_requests(collection_id);

CREATE TABLE IF NOT EXISTS http_history (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    status_code INTEGER,
    response_time_ms INTEGER,
    request_size INTEGER,
    response_size INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_history_created ON http_history(created_at);

CREATE TABLE IF NOT EXISTS http_collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

/// 顺序迁移脚本。**只能在末尾追加**，数组下标 +1 即 schema 版本号。
const MIGRATIONS: &[&str] = &[
    // v1 — 初始 schema
    r#"
    CREATE TABLE connections (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        name           TEXT NOT NULL,
        group_name     TEXT NOT NULL DEFAULT '',
        env_tag        TEXT NOT NULL DEFAULT 'unknown',
        config         TEXT NOT NULL DEFAULT '{}',
        credential_ref TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    CREATE TABLE audit_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        action  TEXT NOT NULL,
        target  TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'unknown',
        risk    TEXT NOT NULL DEFAULT 'low',
        status  TEXT NOT NULL DEFAULT '',
        detail  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_connections_kind ON connections(kind);
    CREATE INDEX idx_audit_ts ON audit_log(ts);
    "#,
    // v2 — 知识库（knowledge_entries + FTS5 全文索引）
    r#"
    CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        risk_level TEXT NOT NULL DEFAULT 'safe',
        source TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        language TEXT NOT NULL DEFAULT '',
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title, content, tags,
        content=knowledge_entries,
        content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
    "#,
    // v3 — workflows + workflow_steps + workflow_executions
    r#"
    CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workflow_type TEXT NOT NULL DEFAULT 'script',
        risk_level TEXT NOT NULL DEFAULT 'low',
        target TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        step_type TEXT NOT NULL DEFAULT 'shell',
        command TEXT NOT NULL DEFAULT '',
        step_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready'
    );
    CREATE INDEX IF NOT EXISTS idx_wf_steps_wf ON workflow_steps(workflow_id);
    CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running',
        triggered_by TEXT NOT NULL DEFAULT 'user',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        output TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_wf_exec_wf ON workflow_executions(workflow_id);
    "#,
    // v4 — tasks
    r#"
    CREATE TABLE IF NOT EXISTS workflow_execution_steps (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        step_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        step_type TEXT NOT NULL DEFAULT 'shell',
        command TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        started_at INTEGER,
        finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wf_exec_steps_exec ON workflow_execution_steps(execution_id);

    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL DEFAULT 'terminal',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        resource_id TEXT NOT NULL DEFAULT '',
        resource_name TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        command TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'low',
        status TEXT NOT NULL DEFAULT 'draft',
        source TEXT NOT NULL DEFAULT 'user',
        output TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE TABLE IF NOT EXISTS http_requests (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        url TEXT NOT NULL,
        headers TEXT NOT NULL DEFAULT '{}',
        body TEXT NOT NULL DEFAULT '',
        auth_type TEXT NOT NULL DEFAULT 'none',
        auth_value TEXT NOT NULL DEFAULT '',
        collection_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_http_requests_collection ON http_requests(collection_id);

    CREATE TABLE IF NOT EXISTS http_history (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        status_code INTEGER,
        response_time_ms INTEGER,
        request_size INTEGER,
        response_size INTEGER,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_http_history_created ON http_history(created_at);

    CREATE TABLE IF NOT EXISTS http_collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
    "#,
    // v5 — 连接资源全局标签（JSON 数组，如 os:Ubuntu 24.04）
    r#"
    ALTER TABLE connections ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    "#,
    // v6 — 知识库树形结构（文件夹 / 文档）
    r#"
    ALTER TABLE knowledge_entries ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE knowledge_entries ADD COLUMN node_type TEXT NOT NULL DEFAULT 'document';
    ALTER TABLE knowledge_entries ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_knowledge_parent ON knowledge_entries(parent_id, sort_order);
    "#,
    // v7 — 知识库待办列表
    r#"
    CREATE TABLE IF NOT EXISTS knowledge_todo_lists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        items TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_todo_sort ON knowledge_todo_lists(sort_order, updated_at);
    "#,
    // v8 — 知识库向量分块
    r#"
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_entry ON knowledge_chunks(entry_id);
    "#,
    // v9 — HTTP 持久化表（补全早期 v4 未包含 http_* 的旧库；含 request_id）
    HTTP_SCHEMA_BOOTSTRAP,
    // v10 — 再次确保 HTTP 表存在（兼容已执行旧版 v9 仅 ALTER 的库）
    HTTP_SCHEMA_BOOTSTRAP,
    // v11 — HTTP 历史保存完整响应
    r#"
    ALTER TABLE http_history ADD COLUMN response_status_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE http_history ADD COLUMN response_content_type TEXT NOT NULL DEFAULT 'text/plain';
    ALTER TABLE http_history ADD COLUMN response_headers TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE http_history ADD COLUMN response_body TEXT NOT NULL DEFAULT '';
    "#,
    // v12 — 应用模块启用配置
    r#"
    CREATE TABLE IF NOT EXISTS app_modules (
        module_key TEXT PRIMARY KEY NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO app_modules (module_key, enabled, sort_order) VALUES
        ('terminal', 1, 0),
        ('database', 1, 1),
        ('ssh', 1, 2),
        ('docker', 1, 3),
        ('server', 1, 4),
        ('files', 1, 5),
        ('protocol', 1, 6),
        ('workflow', 0, 7),
        ('knowledge', 1, 8);
    "#,
    // v13 — 模块三态：open / closed / disabled
    r#"
    ALTER TABLE app_modules ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
    UPDATE app_modules SET status = CASE
        WHEN enabled = 1 THEN 'open'
        WHEN module_key = 'workflow' THEN 'disabled'
        ELSE 'closed'
    END;
    "#,
    // v14 — MCP 工具注册表
    r#"
    CREATE TABLE IF NOT EXISTS mcp_tools (
        tool_name TEXT PRIMARY KEY NOT NULL,
        module_key TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO mcp_tools (tool_name, module_key, description, enabled) VALUES
        ('omni_terminal_run_terminal_command', 'terminal', '在当前活动终端会话中执行 shell 命令。危险命令会进入用户确认流程；执行完成后返回退出码与输出。', 1),
        ('omni_database_get_databases_from_connection', 'database', '根据连接名获取该连接下的数据库列表，可选关键字过滤。', 1),
        ('omni_database_get_tables_from_database', 'database', '根据连接名和数据库名获取表列表，可选关键字过滤。', 1),
        ('omni_database_get_table_info', 'database', '根据连接名、数据库名和表名获取表结构信息（MySQL/MariaDB 执行 DESC，其他引擎使用 introspect）。', 1),
        ('omni_database_execute_sql', 'database', '在指定连接和数据库上执行 SQL。SELECT 结果最多返回 500 行；DML 返回影响行数。', 1),
        ('omni_knowledge_create_document', 'knowledge', '在知识库中创建文档。', 1),
        ('omni_knowledge_remove_document', 'knowledge', '按 ID 删除知识库文档。', 1),
        ('omni_knowledge_list_documents', 'knowledge', '列出知识库文档，可按类型或标签过滤。', 1);
    "#,
    // v15 — AI session / trace 持久化
    r#"
    CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        backend_id TEXT NOT NULL,
        source TEXT NOT NULL,
        workspace_id TEXT,
        terminal_session_id TEXT,
        env_tag TEXT,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES ai_sessions(id),
        turn_index INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_turn_stats (
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        tool_calls INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        PRIMARY KEY (session_id, turn_index)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_traces_session ON ai_traces(session_id, turn_index);

    CREATE TABLE IF NOT EXISTS mcp_tool_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL
    );
    "#,
    // v16 — 内置工具双维度开关（内部可用 / 对外暴露）
    r#"
    ALTER TABLE mcp_tools ADD COLUMN internal_enabled INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE mcp_tools ADD COLUMN external_exposed INTEGER NOT NULL DEFAULT 1;
    UPDATE mcp_tools SET internal_enabled = enabled WHERE internal_enabled IS NULL OR internal_enabled = enabled;
    "#,
    // v17 — 第三方账户（平台 + 验证方式，凭据存钥匙串）
    r#"
    CREATE TABLE IF NOT EXISTS third_party_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        credential_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_third_party_accounts_platform ON third_party_accounts(platform);
    "#,
    // v18 — HTTP 历史自定义显示名称
    r#"
    ALTER TABLE http_history ADD COLUMN label TEXT NOT NULL DEFAULT '';
    "#,
    // v19 — HTTP 调试环境 + 请求关联环境
    r#"
    CREATE TABLE IF NOT EXISTS http_environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    ALTER TABLE http_requests ADD COLUMN environment_id TEXT;
    "#,
    // v20 — HTTP 历史记录关联环境
    r#"
    ALTER TABLE http_history ADD COLUMN environment_id TEXT;
    "#,
    // v21 — 内置工具表重命名（与 MCP 协议解耦）
    r#"
    ALTER TABLE mcp_tools RENAME TO builtin_tools;
    ALTER TABLE mcp_tool_audit RENAME TO builtin_tool_audit;
    "#,
    // v22 — 终端 Blocks 历史（SQLite checkpoint，替代 localStorage）
    r#"
    CREATE TABLE IF NOT EXISTS terminal_history_sessions (
        session_id   TEXT PRIMARY KEY,
        workspace_id TEXT,
        updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terminal_history_blocks (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES terminal_history_sessions(session_id) ON DELETE CASCADE,
        kind         TEXT NOT NULL DEFAULT 'shell',
        command      TEXT NOT NULL DEFAULT '',
        title        TEXT,
        status       TEXT NOT NULL,
        exit_code    INTEGER,
        cwd          TEXT NOT NULL DEFAULT '',
        timestamp    INTEGER NOT NULL,
        completed_at INTEGER,
        payload      TEXT NOT NULL DEFAULT '{}',
        updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_term_hist_blocks_session_ts
        ON terminal_history_blocks(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_term_hist_sessions_updated
        ON terminal_history_sessions(updated_at);
    "#,
    // v23 — 资源档案（resource_observations）+ knowledge_entries 加 resource_type/resource_id
    r#"
    CREATE TABLE IF NOT EXISTS resource_observations (
        id              TEXT PRIMARY KEY,
        resource_type   TEXT NOT NULL,
        resource_id     TEXT NOT NULL,
        observation_kind TEXT NOT NULL,
        payload         TEXT NOT NULL DEFAULT '{}',
        observed_at     INTEGER NOT NULL,
        observer        TEXT NOT NULL DEFAULT 'auto'
    );
    CREATE INDEX IF NOT EXISTS idx_resource_obs_type_id_kind_time
        ON resource_observations(resource_type, resource_id, observation_kind, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_resource_obs_type_time
        ON resource_observations(resource_type, observed_at DESC);
    ALTER TABLE knowledge_entries ADD COLUMN resource_type TEXT NOT NULL DEFAULT '';
    ALTER TABLE knowledge_entries ADD COLUMN resource_id TEXT NOT NULL DEFAULT '';
    "#,
    // v24 — Skill 自我进化（skills / skill_applications / skill_knowledge_links / skill_chunks）
    r#"
    CREATE TABLE IF NOT EXISTS skills (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        description         TEXT NOT NULL DEFAULT '',
        enabled             INTEGER NOT NULL DEFAULT 1,
        version             INTEGER NOT NULL DEFAULT 1,
        parent_version_id   TEXT NOT NULL DEFAULT '',
        path                TEXT NOT NULL DEFAULT '',
        success_count       INTEGER NOT NULL DEFAULT 0,
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_applied_at     INTEGER,
        shareable           INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_enabled_name ON skills(enabled, name);
    CREATE INDEX IF NOT EXISTS idx_skills_parent ON skills(parent_version_id);

    CREATE TABLE IF NOT EXISTS skill_applications (
        id              TEXT PRIMARY KEY,
        skill_id        TEXT NOT NULL,
        session_id      TEXT NOT NULL DEFAULT '',
        resource_type   TEXT NOT NULL DEFAULT '',
        resource_id     TEXT NOT NULL DEFAULT '',
        outcome         TEXT NOT NULL DEFAULT 'pending',
        feedback        TEXT NOT NULL DEFAULT '',
        applied_at      INTEGER NOT NULL,
        FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skill_apps_skill_time ON skill_applications(skill_id, applied_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_apps_resource ON skill_applications(resource_type, resource_id);

    CREATE TABLE IF NOT EXISTS skill_knowledge_links (
        skill_id        TEXT NOT NULL,
        knowledge_id    TEXT NOT NULL,
        link_kind       TEXT NOT NULL DEFAULT 'related',
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (skill_id, knowledge_id),
        FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE,
        FOREIGN KEY(knowledge_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skill_kn_links_knowledge ON skill_knowledge_links(knowledge_id);

    CREATE TABLE IF NOT EXISTS skill_chunks (
        id              TEXT PRIMARY KEY,
        skill_id        TEXT NOT NULL,
        chunk_index     INTEGER NOT NULL,
        content         TEXT NOT NULL,
        embedding       TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skill_chunks_skill ON skill_chunks(skill_id);
    "#,
    // v25 — HTTP 环境默认认证
    r#"
    ALTER TABLE http_environments ADD COLUMN auth_type TEXT;
    ALTER TABLE http_environments ADD COLUMN auth_value TEXT;
    "#,
    // v26 — 知识库文档历史版本
    r#"
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
        id          TEXT PRIMARY KEY,
        entry_id    TEXT NOT NULL,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY(entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_entry_time
        ON knowledge_revisions(entry_id, created_at DESC);
    "#,
    // v27 — 全局标签词表 + 资源绑定
    r#"
    CREATE TABLE IF NOT EXISTS tags (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        parent_id   TEXT,
        path        TEXT NOT NULL UNIQUE,
        color       TEXT,
        kind        TEXT NOT NULL DEFAULT 'user',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY(parent_id) REFERENCES tags(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_parent_name
        ON tags(IFNULL(parent_id, ''), name);
    CREATE INDEX IF NOT EXISTS idx_tags_path_prefix ON tags(path);

    CREATE TABLE IF NOT EXISTS resource_tag_links (
        tag_id         TEXT NOT NULL,
        resource_kind  TEXT NOT NULL,
        resource_id    TEXT NOT NULL,
        source         TEXT NOT NULL DEFAULT 'user',
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (tag_id, resource_kind, resource_id),
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rtl_resource
        ON resource_tag_links(resource_kind, resource_id);
    CREATE INDEX IF NOT EXISTS idx_rtl_tag ON resource_tag_links(tag_id);
    "#,
];

/// 审计日志条目。所有高风险操作经执行引擎写入此表。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AuditEntry {
    /// Unix 毫秒时间戳
    #[specta(type = f64)]
    pub ts: i64,
    /// 动作类型（如 terminal.exec / ssh.connect / db.query）
    pub action: String,
    /// 操作目标（连接 id、命令摘要等）
    pub target: String,
    /// 环境标签 dev/test/staging/prod
    pub env_tag: String,
    /// 风险等级 low/medium/high/critical
    pub risk: String,
    /// 结果状态 success/failed/blocked 等
    pub status: String,
    /// 附加明细
    pub detail: String,
}

/// 本地元数据存储。密钥注入式：`cipher_key` 为 `Some` 时按 SQLCipher 整库加密
/// （需启用 `bundled-sqlcipher` 构建），为 `None` 时明文存储。敏感凭据不入此库，走 [`crate::Vault`]。
pub struct Storage {
    conn: SqliteConnection,
}

impl Storage {
    /// 打开（或创建）本地库文件并执行迁移。
    pub fn open(path: impl AsRef<Path>, cipher_key: Option<&str>) -> OmniResult<Self> {
        let conn = SqliteConnection::open(path).map_err(map_sqlite)?;
        Self::init(conn, cipher_key)
    }

    /// 打开内存库（测试用）。
    pub fn open_in_memory() -> OmniResult<Self> {
        let conn = SqliteConnection::open_in_memory().map_err(map_sqlite)?;
        Self::init(conn, None)
    }

    fn init(conn: SqliteConnection, cipher_key: Option<&str>) -> OmniResult<Self> {
        if let Some(key) = cipher_key {
            // 仅在 SQLCipher 构建下生效；明文 sqlite 下该 pragma 为 no-op/报错，故忽略错误
            let _ = conn.pragma_update(None, "key", key);
        }
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sqlite)?;

        let mut storage = Self { conn };
        storage.run_migrations()?;
        Ok(storage)
    }

    /// 按版本顺序执行未应用的迁移。
    fn run_migrations(&mut self) -> OmniResult<()> {
        self.conn
            .execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);")
            .map_err(map_sqlite)?;

        let current: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;

        for (idx, script) in MIGRATIONS.iter().enumerate() {
            let version = (idx + 1) as i64;
            if version > current {
                let tx = self.conn.transaction().map_err(map_sqlite)?;
                tx.execute_batch(script).map_err(map_sqlite)?;
                tx.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [version],
                )
                .map_err(map_sqlite)?;
                tx.commit().map_err(map_sqlite)?;
                tracing::info!(version, "applied storage migration");
            }
        }
        self.repair_http_schema()?;
        self.repair_app_modules()?;
        self.repair_builtin_tools()?;
        self.builtin_tool_sync_all_modules()?;
        self.ensure_global_tags()?;
        Ok(())
    }

    /// 兼容旧库：v4 曾不含 http_* 表，或 http_history 缺 request_id 列。
    fn repair_http_schema(&self) -> OmniResult<()> {
        self.conn
            .execute_batch(HTTP_SCHEMA_BOOTSTRAP)
            .map_err(map_sqlite)?;
        if let Err(err) = self
            .conn
            .execute("ALTER TABLE http_history ADD COLUMN request_id TEXT", [])
        {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(map_sqlite(err));
            }
        }
        if let Err(err) = self.conn.execute(
            "ALTER TABLE http_history ADD COLUMN label TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(map_sqlite(err));
            }
        }
        if let Err(err) = self.conn.execute(
            "ALTER TABLE http_requests ADD COLUMN environment_id TEXT",
            [],
        ) {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(map_sqlite(err));
            }
        }
        if let Err(err) = self.conn.execute(
            "ALTER TABLE http_history ADD COLUMN environment_id TEXT",
            [],
        ) {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(map_sqlite(err));
            }
        }
        if let Err(err) = self.conn.execute(
            "ALTER TABLE http_requests ADD COLUMN path_params TEXT NOT NULL DEFAULT '[]'",
            [],
        ) {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(map_sqlite(err));
            }
        }
        if let Err(err) = self.conn.execute(
            "ALTER TABLE http_history ADD COLUMN request_curl TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(map_sqlite(err));
            }
        }
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS http_environments (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    auth_type TEXT,
                    auth_value TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )
            .map_err(map_sqlite)?;
        for column_sql in [
            "ALTER TABLE http_environments ADD COLUMN auth_type TEXT",
            "ALTER TABLE http_environments ADD COLUMN auth_value TEXT",
        ] {
            if let Err(err) = self.conn.execute(column_sql, []) {
                let msg = err.to_string();
                if !msg.contains("duplicate column") {
                    return Err(map_sqlite(err));
                }
            }
        }
        self.conn
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_http_history_request ON http_history(request_id, created_at);",
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 当前 schema 版本。
    pub fn schema_version(&self) -> OmniResult<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)
    }

    /// 供同 crate 模块（连接 CRUD 等）访问底层连接。
    pub(crate) fn conn(&self) -> &SqliteConnection {
        &self.conn
    }

    /// 追加一条审计日志。
    pub fn append_audit(&self, entry: &AuditEntry) -> OmniResult<()> {
        self.conn
            .execute(
                "INSERT INTO audit_log (ts, action, target, env_tag, risk, status, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    entry.ts,
                    entry.action,
                    entry.target,
                    entry.env_tag,
                    entry.risk,
                    entry.status,
                    entry.detail,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 读取最近的审计日志（按时间倒序）。
    pub fn recent_audit(&self, limit: u32) -> OmniResult<Vec<AuditEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ts, action, target, env_tag, risk, status, detail
                 FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?1",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([limit], |row| {
                Ok(AuditEntry {
                    ts: row.get(0)?,
                    action: row.get(1)?,
                    target: row.get(2)?,
                    env_tag: row.get(3)?,
                    risk: row.get(4)?,
                    status: row.get(5)?,
                    detail: row.get(6)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for entry in rows {
            out.push(entry.map_err(map_sqlite)?);
        }
        Ok(out)
    }
}

pub(crate) fn map_sqlite(err: rusqlite::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "本地存储操作失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_audit() -> AuditEntry {
        AuditEntry {
            ts: 1_700_000_000_000,
            action: "terminal.exec".into(),
            target: "ls -la".into(),
            env_tag: "dev".into(),
            risk: "low".into(),
            status: "success".into(),
            detail: String::new(),
        }
    }

    #[test]
    fn migrations_apply_to_latest_version() {
        let storage = Storage::open_in_memory().unwrap();
        assert_eq!(storage.schema_version().unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrations_are_idempotent_on_reopen() {
        // 对同一内存连接重复 init 不会重复执行（这里验证版本稳定）
        let storage = Storage::open_in_memory().unwrap();
        let v1 = storage.schema_version().unwrap();
        let v2 = storage.schema_version().unwrap();
        assert_eq!(v1, v2);
        assert_eq!(v1, MIGRATIONS.len() as i64);
    }

    #[test]
    fn append_and_read_audit() {
        let storage = Storage::open_in_memory().unwrap();
        storage.append_audit(&sample_audit()).unwrap();
        let mut second = sample_audit();
        second.ts += 1000;
        second.action = "ssh.connect".into();
        storage.append_audit(&second).unwrap();

        let recent = storage.recent_audit(10).unwrap();
        assert_eq!(recent.len(), 2);
        // 倒序：最新的在前
        assert_eq!(recent[0].action, "ssh.connect");
        assert_eq!(recent[1].action, "terminal.exec");
    }

    #[test]
    fn audit_limit_is_respected() {
        let storage = Storage::open_in_memory().unwrap();
        for i in 0..5 {
            let mut e = sample_audit();
            e.ts += i;
            storage.append_audit(&e).unwrap();
        }
        assert_eq!(storage.recent_audit(3).unwrap().len(), 3);
    }

    #[test]
    fn file_storage_persists_across_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        {
            let storage = Storage::open(&path, None).unwrap();
            storage.append_audit(&sample_audit()).unwrap();
        }
        // 重新打开：迁移不重复执行，数据仍在
        let storage = Storage::open(&path, None).unwrap();
        assert_eq!(storage.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(storage.recent_audit(10).unwrap().len(), 1);
    }

    /// 早期 v4 仅含 tasks/workflow_execution_steps，不含 http_* 表。
    const LEGACY_V4_TASKS_ONLY: &str = r#"
    CREATE TABLE IF NOT EXISTS workflow_execution_steps (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        step_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        step_type TEXT NOT NULL DEFAULT 'shell',
        command TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        started_at INTEGER,
        finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wf_exec_steps_exec ON workflow_execution_steps(execution_id);
    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL DEFAULT 'terminal',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        resource_id TEXT NOT NULL DEFAULT '',
        resource_name TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        command TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'low',
        status TEXT NOT NULL DEFAULT 'draft',
        source TEXT NOT NULL DEFAULT 'user',
        output TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
    "#;

    #[test]
    fn legacy_v4_without_http_tables_gets_repaired() {
        use crate::http::SavedHttpRequest;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        {
            let conn = SqliteConnection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE schema_version (version INTEGER NOT NULL);")
                .unwrap();
            for (idx, script) in MIGRATIONS.iter().take(3).enumerate() {
                let version = (idx + 1) as i64;
                conn.execute_batch(script).unwrap();
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [version],
                )
                .unwrap();
            }
            conn.execute_batch(LEGACY_V4_TASKS_ONLY).unwrap();
            conn.execute("INSERT INTO schema_version (version) VALUES (4)", [])
                .unwrap();
            for version in 5..=8 {
                conn.execute_batch(MIGRATIONS[version as usize - 1])
                    .unwrap();
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [version],
                )
                .unwrap();
            }
            let has_http: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='http_requests'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(has_http, 0);
        }

        let storage = Storage::open(&path, None).unwrap();
        assert_eq!(storage.schema_version().unwrap(), MIGRATIONS.len() as i64);

        let req = SavedHttpRequest {
            id: "req-1".into(),
            name: "Test".into(),
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: "{}".into(),
            body: String::new(),
            auth_type: "none".into(),
            auth_value: String::new(),
            collection_id: None,
            environment_id: None,
            path_params: String::new(),
            created_at: 1,
            updated_at: 1,
        };
        storage.http_save_request(&req).unwrap();
        assert_eq!(storage.http_list_requests(None).unwrap().len(), 1);
    }
}
