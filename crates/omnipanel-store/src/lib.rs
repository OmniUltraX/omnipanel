//! 本地存储与凭据库：rusqlite 元数据存储（密钥注入式，可选 SQLCipher）+ keyring 凭据保管。
//! 应用数据根目录为 `~/.omnipd`，各模块使用独立子目录。

mod connection;
mod database;
mod knowledge;
mod paths;
mod schema_filters;
mod storage;
mod task;
mod vault;
mod workflow;

pub use connection::{Connection, ConnectionKind};
pub use database::{
    DatabaseConnectionStore, DbConnectionConfig, load_database_connections,
    save_database_connections,
};
pub use paths::{
    database_connections_path, database_schema_filters_path, meta_db_path, module_dir, omnipd_root,
};
pub use schema_filters::{
    SchemaFilterRecord, SchemaFiltersSnapshot, load_schema_filters, prune_connection_filters,
    save_schema_filters,
};
pub use storage::{AuditEntry, Storage};
pub use knowledge::{KnowledgeEntry, KnowledgeSearchResult};
pub use task::{SaveTaskRequest, Task, TaskRisk, TaskSource, TaskStatus, TaskType};
pub use vault::Vault;
pub use workflow::{
    ExecutionStatus, RiskLevel, SaveStepRequest, SaveWorkflowRequest, StepStatus, StepType,
    Workflow, WorkflowDetail, WorkflowExecution, WorkflowExecutionDetail, WorkflowExecutionStep,
    WorkflowStep, WorkflowType,
};
