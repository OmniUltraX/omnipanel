//! 连接 / 本地 FS / 对象存储抽象（桌面 `file_manager`、Web `files` 适配）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_error::OmniResult;
use omnipanel_ssh::{SshConfig, SshSession};

/// 本机连接占位 id（与桌面 / Web 一致）。
pub const LOCAL_CONNECTION_ID: &str = "__local__";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TransferProtocol {
    Local,
    Sftp,
    Ftp,
    S3,
}

#[derive(Debug, Clone)]
pub struct TransferDirEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct SftpEndpointInfo {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub public_ip: Option<String>,
}

/// 文件传输宿主能力：会话、本地 FS、S3/FTP 等由桌面 / Web 注入。
#[async_trait]
pub trait TransferHost: Send + Sync {
    fn local_connection_id(&self) -> &'static str {
        LOCAL_CONNECTION_ID
    }

    fn resolve_local_path(&self, path: &str) -> OmniResult<PathBuf>;
    fn list_local_dir(&self, path: &str) -> OmniResult<Vec<TransferDirEntry>>;
    fn local_home(&self) -> OmniResult<String>;
    fn local_temp_dir(&self) -> OmniResult<PathBuf>;

    async fn connection_protocol(&self, connection_id: &str) -> OmniResult<TransferProtocol>;
    async fn open_sftp(&self, connection_id: &str) -> OmniResult<Arc<SshSession>>;
    async fn dest_path_exists(&self, connection_id: &str, path: &str) -> OmniResult<bool>;

    async fn s3_server_copy_eligible(&self, source_id: &str, dest_id: &str) -> bool;
    async fn remote_direct_eligible(&self, source_id: &str, dest_id: &str) -> bool;
    async fn resolve_sftp_endpoint(&self, connection_id: &str) -> OmniResult<SftpEndpointInfo>;
    async fn ssh_config_from_connection(&self, connection_id: &str) -> OmniResult<SshConfig>;

    async fn s3_get_bytes(&self, connection_id: &str, key: &str) -> OmniResult<Vec<u8>>;
    async fn s3_put_bytes(&self, connection_id: &str, key: &str, data: &[u8]) -> OmniResult<()>;
    async fn s3_copy_internal(
        &self,
        connection_id: &str,
        src_key: &str,
        dst_key: &str,
    ) -> OmniResult<()>;
    async fn s3_copy_cross_bucket(
        &self,
        source_id: &str,
        src_key: &str,
        dest_id: &str,
        dst_key: &str,
    ) -> OmniResult<()>;
    async fn s3_bucket_name(&self, connection_id: &str) -> OmniResult<String>;
    async fn s3_download_to_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64>;
    async fn s3_upload_from_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64>;
    async fn s3_delete_object(&self, connection_id: &str, key: &str) -> OmniResult<()>;
    async fn same_s3_bucket_and_endpoint(&self, a: &str, b: &str) -> OmniResult<bool>;

    async fn ftp_download_to_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64>;
    async fn ftp_upload_from_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64>;
}

/// SSH 会话提供者（relay / db-sync 风格别名）。
#[async_trait]
pub trait SessionProvider: Send + Sync {
    async fn open_sftp(&self, connection_id: &str) -> OmniResult<Arc<SshSession>>;
}

#[async_trait]
impl<T: TransferHost + ?Sized> SessionProvider for T {
    async fn open_sftp(&self, connection_id: &str) -> OmniResult<Arc<SshSession>> {
        TransferHost::open_sftp(self, connection_id).await
    }
}
