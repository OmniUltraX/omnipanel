//! 本地存储与凭据库：rusqlite 元数据存储（密钥注入式，可选 SQLCipher）+ keyring 凭据保管。
//! 应用数据根目录为 `~/.omnipd`，各模块使用独立子目录。

mod ai_trace;
mod mcp_tool;
mod mcp_tool_spec;
mod app_module;
mod connection;
mod database;
mod file_index;
mod file_index_storage;
mod http;
mod knowledge;
mod knowledge_todo;
mod knowledge_vector;
mod paths;
mod schema_cache;
mod schema_filters;
mod schema_tree_expanded;
mod storage;
mod task;
mod vault;
mod workflow;

pub use ai_trace::{AiSessionRecord, AiTraceRecord};
pub use mcp_tool::{McpToolCatalogEntry, McpToolRecord};
pub use mcp_tool_spec::{
    builtin_tool_is_native, builtin_tool_spec, BuiltinToolSpec, ToolExecKind, BUILTIN_TOOL_SPECS,
};
pub use app_module::{AppModule, AppModuleStatus, DEFAULT_APP_MODULES};
pub use connection::{Connection, ConnectionKind};
pub use file_index::{
    FileIndexBatchItem, FileIndexEntry, FileIndexProgress, FileIndexSearchResult, FileIndexStatus,
};
pub use file_index_storage::{FileIndexStorage, resolve_file_index_db_path};
pub use paths::default_file_index_storage_dir;
pub use database::{
    DatabaseConnectionStore, DbConnectionConfig, load_database_connections,
    save_database_connections,
};
pub use http::{HttpCollection, HttpHistoryEntry, SavedHttpRequest};
pub use knowledge::{KnowledgeEntry, KnowledgeSearchResult};
pub use knowledge_todo::{KnowledgeTodoItem, KnowledgeTodoList};
pub use knowledge_vector::{
    KnowledgeChunkListResult, KnowledgeChunkPreview, KnowledgeChunkRecord, KnowledgeRecallHit,
    KnowledgeVectorHit,
    KnowledgeVectorStatus, chunk_text,
};
pub use paths::{
    ai_config_dir, ai_providers_path, cli_providers_path, database_connections_path,
    database_schema_cache_path, database_schema_filters_path, database_schema_tree_expanded_path,
    mcp_services_path, meta_db_path, module_dir, omnipd_root, skills_root,
};
pub use schema_cache::{
    SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase, SchemaCacheIndex,
    SchemaCacheRoutine, SchemaCacheSnapshot, SchemaCacheTable, SchemaCacheUser, load_schema_cache,
    prune_connection_cache, save_schema_cache,
};
pub use schema_filters::{
    SchemaFilterRecord, SchemaFiltersSnapshot, load_schema_filters, prune_connection_filters,
    save_schema_filters,
};
pub use schema_tree_expanded::{
    SchemaTreeExpandedSnapshot, load_schema_tree_expanded, prune_connection_expanded,
    save_schema_tree_expanded,
};
pub use storage::{AuditEntry, Storage};
pub use task::{SaveTaskRequest, Task, TaskRisk, TaskSource, TaskStatus, TaskType};
pub use vault::Vault;
pub use workflow::{
    ExecutionStatus, RiskLevel, SaveStepRequest, SaveWorkflowRequest, StepStatus, StepType,
    Workflow, WorkflowDetail, WorkflowExecution, WorkflowExecutionDetail, WorkflowExecutionStep,
    WorkflowStep, WorkflowType,
};
