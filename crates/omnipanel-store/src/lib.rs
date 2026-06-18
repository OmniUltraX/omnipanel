//! 本地存储与凭据库：rusqlite 元数据存储（密钥注入式，可选 SQLCipher）+ keyring 凭据保管。
//! 应用数据根目录为 `~/.omnipd`，各模块使用独立子目录。

mod connection;
mod database;
mod http;
mod knowledge;
mod knowledge_todo;
mod paths;
mod schema_cache;
mod schema_filters;
mod schema_tree_expanded;
mod storage;
mod task;
mod vault;
mod workflow;

pub use connection::{Connection, ConnectionKind};
pub use database::{
    DatabaseConnectionStore, DbConnectionConfig, load_database_connections,
    save_database_connections,
};
pub use http::{HttpCollection, HttpHistoryEntry, SavedHttpRequest};
pub use knowledge::{KnowledgeEntry, KnowledgeSearchResult};
pub use knowledge_todo::{KnowledgeTodoItem, KnowledgeTodoList};
pub use paths::{
    database_connections_path, database_schema_cache_path, database_schema_filters_path,
    database_schema_tree_expanded_path, mcp_services_path, meta_db_path, module_dir, omnipd_root,
};
pub use schema_cache::{
    SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase, SchemaCacheIndex,
    SchemaCacheSnapshot, SchemaCacheTable, load_schema_cache, prune_connection_cache,
    save_schema_cache,
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
