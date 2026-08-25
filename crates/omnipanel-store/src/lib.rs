//! 本地存储与凭据库：rusqlite 元数据存储（密钥注入式，可选 SQLCipher）+ keyring 凭据保管。
//! 应用数据根目录为 `~/.omnipd`，各模块使用独立子目录。

mod ai_trace;
mod agent_prompt;
mod bg_task_history;
mod builtin_tool;
mod builtin_tool_spec;
mod app_module;
mod connection;
mod external_source;
mod database;
mod file_index;
mod file_index_storage;
mod file_transfer;
mod http;
mod knowledge;
mod knowledge_todo;
mod knowledge_vector;
mod todo;
mod embedding_config;
mod host_resolve_cache;
mod paths;
mod plugin_settings;
mod resource_profile;
mod skill;
mod skill_db;
mod skill_seed;
mod schema_cache;
mod schema_filters;
mod schema_tree_expanded;
mod storage;
mod tag;
mod task;
mod task_events;
mod terminal_history;
mod third_party_account;
mod vault;
mod ssh_vault;
mod secrets_crypto;
mod sync_crypto;
mod sync_master_key;
mod sync_team_key;
mod assistant_binding_key;
mod assistant_payload;
mod sync_key_wrap;
mod http_proxy;
mod web_search;
mod workflow;

pub use agent_prompt::{
    agent_prompt, clear_prompt_cache, client_tools_preamble, ensure_default_prompts,
    list_prompt_entries, reset_prompt, routing_policy, save_prompt, system_prompt,
    AgentPromptEntry, AGENT_PROMPT_IDS,
};
pub use ai_trace::{AiSessionRecord, AiTraceRecord, BuiltinToolAuditRecord};
pub use bg_task_history::BgTaskHistoryRecord;
pub use task_events::{TaskEventFilter, TaskEventRecord};
pub use builtin_tool::{BuiltinToolCatalogEntry, BuiltinToolRecord};
pub use builtin_tool_spec::{
    builtin_tool_is_cross_module, builtin_tool_is_native, builtin_tool_module_key,
    builtin_tool_omnimcp_backend, builtin_tool_spec, BuiltinToolSpec, ToolExecKind,
    BUILTIN_TOOL_SPECS,
};
pub use app_module::{AppModule, AppModuleStatus, DEFAULT_APP_MODULES};
pub use connection::{Connection, ConnectionKind};
pub use external_source::{
    migrate_cloud_source_in_config, parse_external_source, parse_external_source_value,
    ExternalSource,
};
pub use file_index::{
    FileIndexBatchItem, FileIndexEntry, FileIndexProgress, FileIndexSearchResult, FileIndexStatus,
};
pub use file_index_storage::{FileIndexStorage, resolve_file_index_db_path};
pub use file_transfer::FileTransferJobRecord;
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
    ensure_builtin_demo_connections, fill_db_password_from_vault, mark_builtin_demo_removed,
    DatabaseConnectionStore, DbConnectionConfig, BUILTIN_FILE_INDEX_CONN_ID,
    BUILTIN_META_DB_CONN_ID, load_database_connections, save_database_connections,
};
pub use http::{HttpCollection, HttpEnvironment, HttpHistoryEntry, SavedHttpRequest};
pub use knowledge::{KnowledgeEntry, KnowledgeRevision, KnowledgeSearchResult};
pub use knowledge_todo::{KnowledgeTodoItem, KnowledgeTodoList};
pub use todo::{TodoList, TodoRecurrence, TodoStep, TodoTask, TodoTaskQuery};
pub use knowledge_vector::{
    KnowledgeChunkListResult, KnowledgeChunkPreview, KnowledgeChunkRecord, KnowledgeRecallHit,
    KnowledgeVectorHit, KnowledgeVectorStatus, chunk_text, cosine_similarity,
};
pub use http_proxy::{
    load_http_proxy_config, load_http_proxy_config_with_secret, save_http_proxy_config,
    HttpProxyConfig,
};
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
    database_schema_tree_expanded_path, http_proxy_config_path, knowledge_assets_root,
    knowledge_entry_assets_dir, mcp_services_path, meta_db_path, module_dir, omnipd_root,
    prompts_root, skills_root, web_search_config_path,
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
    build_selected_skills_bodies_append, build_skills_system_append,
    build_skills_system_append_filtered, extract_skill_body,
    list_all_skill_records, list_enabled_skill_summaries, load_skill_body, load_skill_record,
    parse_skill_md, render_skill_md, sanitize_skill_id, skill_dir, skill_file_path, write_skill,
    ParsedSkill, SkillFrontmatter, SkillRecord, SKILL_MD_FILENAME,
};
pub use skill_seed::{ensure_agent_defaults, ensure_default_skills};
pub use storage::{AuditEntry, Storage};
pub use tag::{
    normalize_tag_path, normalize_tag_segment, ResourceTagDto, SearchEverywhereHit, TagDto,
    TagMatchMode, TagSource, TaggableKind, TaggedResourceSummary,
};
pub use task::{SaveTaskRequest, Task, TaskRisk, TaskSource, TaskStatus, TaskType};
pub use terminal_history::{
    TerminalHistoryBlockRecord, TerminalHistoryRetainPolicy, sanitize_payload_json,
};
pub use third_party_account::{
    ThirdPartyAccount, ThirdPartyAuthMethod, ThirdPartyPlatform, UpsertThirdPartyAccountInput,
};
pub use vault::Vault;
pub use secrets_crypto::{
    decode_salt_b64, decrypt_bind_token_wrap, decrypt_vault, decrypt_with_passphrase,
    derive_master_key, encrypt_bind_token_wrap, encrypt_vault_with_salt, encrypt_with_passphrase,
    generate_salt, MasterKey, SecretsVaultEnvelope, SecretsVaultEntry, SecretsVaultPlaintext,
};
pub use assistant_payload::{
    build_assistant_payload_envelope, AssistantPayloadEnvelope, ASSISTANT_PAYLOAD_KIND,
};
pub use sync_key_wrap::{
    decrypt_assistant_payload, encrypt_assistant_payload, generate_pairing_keypair,
    unwrap_sync_master_key, unwrap_sync_team_key, wrap_sync_master_key, wrap_sync_team_key,
    WRAP_ALG,
};
pub use sync_master_key::{
    clear_stored_sync_master_key, decode_sync_master_key_bytes, generate_sync_master_key,
    get_or_create_sync_master_key, is_valid_sync_master_key, load_stored_sync_master_key,
    normalize_sync_master_key, store_sync_master_key, sync_master_key_to_password,
    SYNC_MASTER_KEY_PREFIX,
};
pub use sync_crypto::{
    decode_sync_blob_or_legacy, decode_sync_blob_with_sources, decrypt_sync_blob,
    derive_sync_blob_key_material_v2, encrypt_sync_blob, encrypt_sync_team_blob,
    looks_like_sync_blob_envelope, SyncBlobEnvelope, SYNC_BLOB_SCHEME, SYNC_BLOB_SCHEME_V2,
    SYNC_KIND_CONVERSATIONS, SYNC_KIND_MODULES,
};
pub use assistant_binding_key::{
    clear_assistant_binding_pubkey, load_assistant_binding_pubkey, store_assistant_binding_pubkey,
};
pub use sync_team_key::{
    clear_sync_team_key, export_sync_team_key_json, generate_sync_team_key,
    get_or_create_sync_team_key, import_sync_team_key_json, load_sync_team_key,
    store_sync_team_key, sync_team_key_fingerprint, SyncTeamKeyExportFile,
    SYNC_TEAM_KEY_BYTES, SYNC_TEAM_KEY_EXPORT_VERSION, SYNC_TEAM_KEY_FILE_EXT,
};
pub use ssh_vault::{
    ai_provider_key_ref, db_password_ref, embedding_api_key_ref, http_proxy_password_ref,
    inject_ssh_vault_into_config, ssh_passphrase_ref, ssh_password_ref, ssh_pem_ref,
};
pub use workflow::{
    ExecutionStatus, RiskLevel, SaveStepRequest, SaveWorkflowRequest, StepStatus, StepType,
    Workflow, WorkflowDetail, WorkflowExecution, WorkflowExecutionDetail, WorkflowExecutionStep,
    WorkflowStep, WorkflowType,
};
