//! Web 端适配：将 `ServerState` 桥接到 `omnipanel-transfer`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_s3::S3Config;
use omnipanel_ssh::SshConfig;
use omnipanel_transfer::{
    provider::{SftpEndpointInfo, TransferDirEntry, TransferHost, TransferProtocol},
    remote_direct::remote_direct_eligible,
    types::{FileTransferJob, TRANSFER_PROGRESS_EVENT},
    TransferEventSink,
};

use crate::bus::EventBus;
use crate::files::{
    self, ftp_connect_sync, ftp_remote_path, list_local_dir, load_file_connection,
    local_home, parse_file_config, protocol_of, resolve_local_path, resolve_secret,
    sftp_session_for, LOCAL_CONNECTION_ID,
};
use crate::terminal::ServerState;

pub struct ServerTransferHost(pub Arc<ServerState>);

pub struct ServerTransferSink(pub EventBus);

#[async_trait]
impl TransferEventSink for ServerTransferSink {
    async fn emit_transfer_job(&self, job: &FileTransferJob) {
        self.0.emit(
            TRANSFER_PROGRESS_EVENT,
            serde_json::to_value(job).unwrap_or_default(),
        );
    }
}

fn map_protocol(proto: &str) -> TransferProtocol {
    match proto {
        "sftp" => TransferProtocol::Sftp,
        "ftp" => TransferProtocol::Ftp,
        "s3" => TransferProtocol::S3,
        _ => TransferProtocol::Local,
    }
}

async fn load_cfg(
    state: &ServerState,
    connection_id: &str,
) -> OmniResult<(omnipanel_store::Connection, files::FileConnConfig, String)> {
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    Ok((conn, cfg, secret))
}

async fn s3_client_for(
    state: &ServerState,
    connection_id: &str,
) -> OmniResult<omnipanel_s3::S3Client> {
    let (_, cfg, secret) = load_cfg(state, connection_id).await?;
    if protocol_of(&cfg) != "s3" {
        return Err(OmniError::invalid_input(format!(
            "连接不是 S3 类型: {connection_id}"
        )));
    }
    let s3_cfg = S3Config {
        bucket: cfg.bucket.clone(),
        provider: cfg.provider.clone(),
        region: cfg.region.clone(),
        endpoint: cfg.endpoint.clone(),
        access_key: cfg.access_key.clone(),
        prefix: cfg.prefix.clone(),
    };
    omnipanel_s3::S3Client::new(s3_cfg, secret)
}

async fn ssh_config_from_file_conn(
    state: &ServerState,
    conn: &omnipanel_store::Connection,
    cfg: &files::FileConnConfig,
) -> OmniResult<SshConfig> {
    files::ssh_config_from_file_conn(state, conn, cfg).await
}

#[async_trait]
impl TransferHost for ServerTransferHost {
    fn local_connection_id(&self) -> &'static str {
        LOCAL_CONNECTION_ID
    }

    fn resolve_local_path(&self, path: &str) -> OmniResult<PathBuf> {
        resolve_local_path(path)
    }

    fn list_local_dir(&self, path: &str) -> OmniResult<Vec<TransferDirEntry>> {
        list_local_dir(path).map(|entries| {
            entries
                .into_iter()
                .map(|e| TransferDirEntry {
                    name: e.name,
                    path: e.path,
                    kind: e.kind,
                    size: Some(e.size as f64),
                })
                .collect()
        })
    }

    fn local_home(&self) -> OmniResult<String> {
        local_home().map(|p| p.to_string_lossy().into_owned())
    }

    fn local_temp_dir(&self) -> OmniResult<PathBuf> {
        Ok(std::env::temp_dir())
    }

    async fn connection_protocol(&self, connection_id: &str) -> OmniResult<TransferProtocol> {
        if connection_id == LOCAL_CONNECTION_ID {
            return Ok(TransferProtocol::Local);
        }
        let (_, cfg, _) = load_cfg(self.0.as_ref(), connection_id).await?;
        Ok(map_protocol(protocol_of(&cfg)))
    }

    async fn open_sftp(&self, connection_id: &str) -> OmniResult<Arc<omnipanel_ssh::SshSession>> {
        let (conn, cfg, _) = load_cfg(self.0.as_ref(), connection_id).await?;
        sftp_session_for(self.0.as_ref(), connection_id, &conn, &cfg).await
    }

    async fn dest_path_exists(&self, connection_id: &str, path: &str) -> OmniResult<bool> {
        if connection_id == LOCAL_CONNECTION_ID {
            return Ok(resolve_local_path(path)
                .map(|p| p.exists())
                .unwrap_or(false));
        }
        match self.connection_protocol(connection_id).await? {
            TransferProtocol::Sftp => {
                let session = self.open_sftp(connection_id).await?;
                Ok(session.sftp_exists(path).await)
            }
            _ => Ok(false),
        }
    }

    async fn s3_server_copy_eligible(&self, source_id: &str, dest_id: &str) -> bool {
        let Ok((_, src_cfg, _)) = load_cfg(self.0.as_ref(), source_id).await else {
            return false;
        };
        let Ok((_, dst_cfg, _)) = load_cfg(self.0.as_ref(), dest_id).await else {
            return false;
        };
        if src_cfg.access_key.trim().is_empty()
            || src_cfg.access_key.trim() != dst_cfg.access_key.trim()
        {
            return false;
        }
        let src_ep = src_cfg.endpoint.trim().to_ascii_lowercase();
        let dst_ep = dst_cfg.endpoint.trim().to_ascii_lowercase();
        if !src_ep.is_empty() && !dst_ep.is_empty() && src_ep != dst_ep {
            return false;
        }
        false
    }

    async fn remote_direct_eligible(&self, source_id: &str, dest_id: &str) -> bool {
        remote_direct_eligible(self, source_id, dest_id).await
    }

    async fn resolve_sftp_endpoint(&self, connection_id: &str) -> OmniResult<SftpEndpointInfo> {
        let (conn, cfg, _) = load_cfg(self.0.as_ref(), connection_id).await?;
        let ssh = ssh_config_from_file_conn(self.0.as_ref(), &conn, &cfg).await?;
        Ok(SftpEndpointInfo {
            host: ssh.host,
            port: ssh.port,
            user: ssh.user,
            public_ip: ssh.public_ip,
        })
    }

    async fn ssh_config_from_connection(&self, connection_id: &str) -> OmniResult<SshConfig> {
        let (conn, cfg, _) = load_cfg(self.0.as_ref(), connection_id).await?;
        ssh_config_from_file_conn(self.0.as_ref(), &conn, &cfg).await
    }

    async fn s3_get_bytes(&self, connection_id: &str, key: &str) -> OmniResult<Vec<u8>> {
        let client = s3_client_for(self.0.as_ref(), connection_id).await?;
        client.get_object(key).await
    }

    async fn s3_put_bytes(
        &self,
        connection_id: &str,
        key: &str,
        data: &[u8],
    ) -> OmniResult<()> {
        let client = s3_client_for(self.0.as_ref(), connection_id).await?;
        client.put_object(key, data).await
    }

    async fn s3_copy_internal(
        &self,
        connection_id: &str,
        src_key: &str,
        dst_key: &str,
    ) -> OmniResult<()> {
        let client = s3_client_for(self.0.as_ref(), connection_id).await?;
        client.copy_object_internal(src_key, dst_key).await
    }

    async fn s3_copy_cross_bucket(
        &self,
        source_id: &str,
        src_key: &str,
        dest_id: &str,
        dst_key: &str,
    ) -> OmniResult<()> {
        let (_, src_cfg, _) = load_cfg(self.0.as_ref(), source_id).await?;
        let client = s3_client_for(self.0.as_ref(), dest_id).await?;
        client
            .copy_object_from_bucket(&src_cfg.bucket, src_key, dst_key)
            .await
    }

    async fn s3_bucket_name(&self, connection_id: &str) -> OmniResult<String> {
        let (_, cfg, _) = load_cfg(self.0.as_ref(), connection_id).await?;
        Ok(cfg.bucket.clone())
    }

    async fn s3_download_to_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        files::file_download_s3_range_to_file(
            self.0.as_ref(),
            connection_id.to_string(),
            remote_path.to_string(),
            local_path.to_string_lossy().into_owned(),
            None,
        )
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, e))
    }

    async fn s3_upload_from_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        let key = remote_path.trim_start_matches('/');
        let data = tokio::fs::read(local_path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Io, "读取临时文件失败").with_cause(e.to_string()))?;
        let n = data.len() as u64;
        self.s3_put_bytes(connection_id, key, &data).await?;
        Ok(n)
    }

    async fn s3_delete_object(&self, connection_id: &str, key: &str) -> OmniResult<()> {
        let client = s3_client_for(self.0.as_ref(), connection_id).await?;
        client.delete_object(key).await
    }

    async fn same_s3_bucket_and_endpoint(&self, a: &str, b: &str) -> OmniResult<bool> {
        let (_, a_cfg, _) = load_cfg(self.0.as_ref(), a).await?;
        let (_, b_cfg, _) = load_cfg(self.0.as_ref(), b).await?;
        Ok(a_cfg.bucket == b_cfg.bucket
            && a_cfg.endpoint.trim().to_ascii_lowercase()
                == b_cfg.endpoint.trim().to_ascii_lowercase())
    }

    async fn ftp_download_to_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        let (_, cfg, secret) = load_cfg(self.0.as_ref(), connection_id).await?;
        let remote = ftp_remote_path(remote_path, &cfg);
        let local_path = local_path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let mut ftp = ftp_connect_sync(&cfg, &secret).map_err(|e| {
                OmniError::new(ErrorCode::Io, "FTP 连接失败").with_cause(e)
            })?;
            let mut reader = ftp.retr_as_stream(&remote).map_err(|e| {
                OmniError::new(ErrorCode::Io, "FTP 下载失败").with_cause(e.to_string())
            })?;
            if let Some(parent) = local_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut file = std::fs::File::create(&local_path).map_err(|e| {
                OmniError::new(ErrorCode::Io, "创建临时文件失败").with_cause(e.to_string())
            })?;
            let n = std::io::copy(&mut reader, &mut file).map_err(|e| {
                OmniError::new(ErrorCode::Io, "FTP 写入失败").with_cause(e.to_string())
            })?;
            file.flush().ok();
            drop(reader);
            let _ = ftp.quit();
            Ok(n)
        })
        .await
        .map_err(|e| OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string()))?
    }

    async fn ftp_upload_from_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        let (_, cfg, secret) = load_cfg(self.0.as_ref(), connection_id).await?;
        let remote = ftp_remote_path(remote_path, &cfg);
        let local_path = local_path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut ftp = ftp_connect_sync(&cfg, &secret).map_err(|e| {
                OmniError::new(ErrorCode::Io, "FTP 连接失败").with_cause(e)
            })?;
            let mut file = std::fs::File::open(&local_path).map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取临时文件失败").with_cause(e.to_string())
            })?;
            let mut data = Vec::new();
            file.read_to_end(&mut data).map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取临时文件失败").with_cause(e.to_string())
            })?;
            ftp.put_file(&remote, &mut &data[..]).map_err(|e| {
                OmniError::new(ErrorCode::Io, "FTP 上传失败").with_cause(e.to_string())
            })?;
            let _ = ftp.quit();
            Ok(data.len() as u64)
        })
        .await
        .map_err(|e| OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string()))?
    }
}

pub fn transfer_host(state: Arc<ServerState>) -> Arc<dyn TransferHost> {
    Arc::new(ServerTransferHost(state))
}

pub fn transfer_sink(bus: EventBus) -> Arc<dyn TransferEventSink> {
    Arc::new(ServerTransferSink(bus))
}
