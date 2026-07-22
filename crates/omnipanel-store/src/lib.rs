//! 本地存储与凭据库：rusqlite 元数据存储（密钥注入式，可选 SQLCipher）+ keyring 凭据保管。
//! 应用数据根目录为 `~/.omnipd`，各模块使用独立子目录。

mod ai_trace;
mod builtin_tool;
mod builtin_tool_spec;
mod app_module;
mod connection;
mod database;
mod file_index;
mod file_index_storage;
mod http;
mod knowledge;
mod knowledge_todo;
mod knowledge_vector;
mod embedding_config;
mod host_resolve_cache;
mod paths;
mod resource_profile;
mod skill;
mod skill_db;
mod schema_cache;
mod schema_filters;
mod schema_tree_expanded;
mod storage;
mod task;
mod terminal_history;
mod third_party_account;
mod vault;
mod http_proxy;
mod web_search;
mod workflow;

pub use ai_trace::{AiSessionRecord, AiTraceRecord, BuiltinToolAuditRecord};
pub use builtin_tool::{BuiltinToolCatalogEntry, BuiltinToolRecord};
pub use builtin_tool_spec::{
    builtin_tool_is_native, builtin_tool_module_key, builtin_tool_omnimcp_backend,
    builtin_tool_spec, BuiltinToolSpec, ToolExecKind, BUILTIN_TOOL_SPECS,
};
pub use app_module::{AppModule, AppModuleStatus, DEFAULT_APP_MODULES};
pub use connection::{Connection, ConnectionKind};
pub use file_index::{
    FileIndexBatchItem, FileIndexEntry, FileIndexProgress, FileIndexSearchResult, FileIndexStatus,
};
pub use file_index_storage::{FileIndexStorage, resolve_file_index_db_path};
pub use host_resolve_cache::{
    get_cached_addresses, load_host_resolve_cache, save_host_resolve_cache, upsert_cache_entry,
    HostResolveEntry,
};
pub use paths::default_file_index_storage_dir;
pub use resource_profile::{ResourceObservation, ResourceProfileSummary};
pub use skill_db::{
    SkillApplication, SkillDbRecord, SkillKnowledgeLink, SkillVectorHit, SkillVectorStatus,
};
pub use embedding_config::{
    default_ollama_embedding_provider, load_embedding_provider, resolve_embedding_provider_for_backend,
    save_embedding_provider, EmbeddingProviderConfig,
};
pub use database::{
    DatabaseConnectionStore, DbConnectionConfig, load_database_connections,
    save_database_connections,
};
pub use http::{HttpCollection, HttpEnvironment, HttpHistoryEntry, SavedHttpRequest};
pub use knowledge::{KnowledgeEntry, KnowledgeSearchResult};
pub use knowledge_todo::{KnowledgeTodoItem, KnowledgeTodoList};
pub use knowledge_vector::{
    KnowledgeChunkListResult, KnowledgeChunkPreview, KnowledgeChunkRecord, KnowledgeRecallHit,
    KnowledgeVectorHit, KnowledgeVectorStatus, chunk_text, cosine_similarity,
};
pub use http_proxy::{load_http_proxy_config, save_http_proxy_config, HttpProxyConfig};
pub use web_search::{
    default_auto_order, delete_exa_api_key, delete_jina_api_key, delete_zhihu_secret,
    exa_api_key_configured, jina_api_key_configured, load_exa_api_key, load_jina_api_key,
    load_web_search_config, load_zhihu_secret, save_exa_api_key, save_jina_api_key,
    save_web_search_config, save_zhihu_secret, zhihu_secret_configured, FetchConfig, JinaDomainMode,
    JinaOpts, SearchConfig, WebFetchBackend, WebSearchBackend, WebSearchConfig,
    WEB_SEARCH_CONFIG_VERSION, WEB_SEARCH_EXA_KEY_REF, WEB_SEARCH_JINA_KEY_REF,
    WEB_SEARCH_ZHIHU_SECRET_REF,
};
pub use paths::{
    ai_config_dir, ai_providers_path, cli_providers_path, database_connections_path,
    database_host_resolve_cache_path, database_schema_cache_path, database_schema_filters_path,
    docker_sidebar_cache_path,
    database_schema_tree_expanded_path, http_proxy_config_path, mcp_services_path, meta_db_path,
    module_dir, omnipd_root, skills_root, web_search_config_path,
};
pub use schema_cache::{
    SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase, SchemaCacheIndex,
    SchemaCacheRoutine, SchemaCacheSnapshot, SchemaCacheTable, SchemaCacheUser, load_schema_cache,
    merge_schema_cache_connection, patch_schema_cache_connection, prune_connection_cache,
    sanitize_bloated_schema_cache_entry, sanitize_redis_schema_cache_entry, save_schema_cache,
};
pub use schema_filters::{
    SchemaFilterRecord, SchemaFiltersSnapshot, load_schema_filters, prune_connection_filters,
    save_schema_filters,
};
pub use schema_tree_expanded::{
    SchemaTreeExpandedSnapshot, load_schema_tree_expanded, prune_connection_expanded,
    save_schema_tree_expanded,
};
pub use skill::{
    build_skills_system_append, extract_skill_body, list_all_skill_records,
    list_enabled_skill_summaries, load_skill_body, load_skill_record, parse_skill_md,
    render_skill_md, sanitize_skill_id, skill_dir, skill_file_path, write_skill, ParsedSkill,
    SkillFrontmatter, SkillRecord,
};
pub use storage::{AuditEntry, Storage};
pub use task::{SaveTaskRequest, Task, TaskRisk, TaskSource, TaskStatus, TaskType};
pub use terminal_history::{
    TerminalHistoryBlockRecord, TerminalHistoryRetainPolicy, sanitize_payload_json,
};
pub use third_party_account::{
    ThirdPartyAccount, ThirdPartyAuthMethod, ThirdPartyPlatform, UpsertThirdPartyAccountInput,
};
pub use vault::Vault;
pub use workflow::{
    ExecutionStatus, RiskLevel, SaveStepRequest, SaveWorkflowRequest, StepStatus, StepType,
    Workflow, WorkflowDetail, WorkflowExecution, WorkflowExecutionDetail, WorkflowExecutionStep,
    WorkflowStep, WorkflowType,
};
