use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferEndpoint {
    pub connection_id: String,
    pub path: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileTransferOp {
    Copy,
    Move,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileTransferRoute {
    Fastpath,
    RemoteDirect,
    Relay,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileTransferConflictPolicy {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileTransferState {
    Queued,
    Probing,
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferItemSpec {
    pub connection_id: String,
    pub path: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub size: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferEnqueueRequest {
    pub items: Vec<FileTransferItemSpec>,
    pub dest_connection_id: String,
    pub dest_dir: String,
    pub op: FileTransferOp,
    pub conflict_policy: FileTransferConflictPolicy,
    #[serde(default)]
    pub force_route: Option<FileTransferRoute>,
    /// ask | always | never
    #[serde(default = "default_direct_policy")]
    pub remote_direct_policy: String,
}

fn default_direct_policy() -> String {
    "ask".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferPlanRequest {
    pub source_connection_id: String,
    pub dest_connection_id: String,
    #[serde(default)]
    pub force_route: Option<FileTransferRoute>,
    #[serde(default = "default_direct_policy")]
    pub remote_direct_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferPlanResult {
    pub route: FileTransferRoute,
    pub route_reason: String,
    pub needs_direct_confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferJob {
    pub id: String,
    pub batch_id: String,
    pub op: FileTransferOp,
    pub source: FileTransferEndpoint,
    pub dest: FileTransferEndpoint,
    pub route: FileTransferRoute,
    pub route_reason: String,
    pub state: FileTransferState,
    pub bytes_done: f64,
    pub bytes_total: Option<f64>,
    pub speed_bps: Option<f64>,
    pub error: Option<String>,
    pub progress: f64,
    /// 源指纹 size+mtime / sftp size，用于断点续传校验
    #[serde(default)]
    pub source_fingerprint: Option<String>,
    /// 本地 partial 路径（目标侧）
    #[serde(default)]
    pub partial_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferListResult {
    pub jobs: Vec<FileTransferJob>,
}

pub const TRANSFER_PROGRESS_EVENT: &str = "files-transfer-progress";
