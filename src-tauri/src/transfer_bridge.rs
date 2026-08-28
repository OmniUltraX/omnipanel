//! Tauri 适配：将 `AppState` 桥接到 `omnipanel-transfer`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshConfig;
use omnipanel_transfer::{
    TransferEventSink,
    provider::{SftpEndpointInfo, TransferDirEntry, TransferHost, TransferProtocol},
    remote_direct::remote_direct_eligible,
    types::{FileTransferJob, TRANSFER_PROGRESS_EVENT},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::file_manager::{
    self, FileConnConfig, FileProtocol, LOCAL_CONNECTION_ID, ftp_connect_sync, ftp_remote_path,
    load_file_connection, parse_file_config, protocol_of, resolve_local_path, resolve_secret,
    s3_copy_object_from_bucket, s3_copy_object_internal, s3_delete_object, s3_get_object_bytes,
    s3_put_object_bytes, sftp_session_for, ssh_config_from_file_conn,
};
use crate::state::AppState;

pub struct TauriTransferHost(pub AppHandle);

pub struct TauriTransferSink(pub AppHandle);

fn app_state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

#[async_trait]
impl TransferEventSink for TauriTransferSink {
    async fn emit_transfer_job(&self, job: &FileTransferJob) {
        let _ = self.0.emit(TRANSFER_PROGRESS_EVENT, job);
    }
}

fn map_protocol(p: FileProtocol) -> TransferProtocol {
    match p {
        FileProtocol::Local => TransferProtocol::Local,
        FileProtocol::Sftp => TransferProtocol::Sftp,
        FileProtocol::Ftp => TransferProtocol::Ftp,
        FileProtocol::S3 => TransferProtocol::S3,
    }
}

async fn load_cfg(
    state: &AppState,
    connection_id: &str,
) -> OmniResult<(omnipanel_store::Connection, FileConnConfig, String)> {
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    Ok((conn, cfg, secret))
}

#[async_trait]
impl TransferHost for TauriTransferHost {
    fn local_connection_id(&self) -> &'static str {
        LOCAL_CONNECTION_ID
    }

    fn resolve_local_path(&self, path: &str) -> OmniResult<PathBuf> {
        resolve_local_path(path)
    }

    fn list_local_dir(&self, path: &str) -> OmniResult<Vec<TransferDirEntry>> {
        file_manager::list_local_dir(path).map(|entries| {
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
        file_manager::local_home().map(|p| p.to_string_lossy().into_owned())
    }

    fn local_temp_dir(&self) -> OmniResult<PathBuf> {
        file_manager::local_temp_dir()
    }

    async fn connection_protocol(&self, connection_id: &str) -> OmniResult<TransferProtocol> {
        if connection_id == LOCAL_CONNECTION_ID {
            return Ok(TransferProtocol::Local);
        }
        let state = app_state(&self.0);
        let (_, cfg, _) = load_cfg(state.inner(), connection_id).await?;
        Ok(map_protocol(protocol_of(&cfg)))
    }

    async fn open_sftp(&self, connection_id: &str) -> OmniResult<Arc<omnipanel_ssh::SshSession>> {
        let state = app_state(&self.0);
        let (conn, cfg, _) = load_cfg(state.inner(), connection_id).await?;
        sftp_session_for(state.inner(), connection_id, &conn, &cfg).await
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
        let state = app_state(&self.0);
        let Ok((_, src_cfg, _)) = load_cfg(state.inner(), source_id).await else {
            return false;
        };
        let Ok((_, dst_cfg, _)) = load_cfg(state.inner(), dest_id).await else {
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
        let src_provider = src_cfg.provider.trim().to_ascii_lowercase();
        let dst_provider = dst_cfg.provider.trim().to_ascii_lowercase();
        !(src_provider == "aliyun" || dst_provider == "aliyun")
    }

    async fn remote_direct_eligible(&self, source_id: &str, dest_id: &str) -> bool {
        remote_direct_eligible(self, source_id, dest_id).await
    }

    async fn resolve_sftp_endpoint(&self, connection_id: &str) -> OmniResult<SftpEndpointInfo> {
        let state = app_state(&self.0);
        let (conn, cfg, _) = load_cfg(state.inner(), connection_id).await?;
        let ssh = ssh_config_from_file_conn(state.inner(), &conn, &cfg).await?;
        Ok(SftpEndpointInfo {
            host: ssh.host,
            port: ssh.port,
            user: ssh.user,
            public_ip: ssh.public_ip,
        })
    }

    async fn ssh_config_from_connection(&self, connection_id: &str) -> OmniResult<SshConfig> {
        let state = app_state(&self.0);
        let (conn, cfg, _) = load_cfg(state.inner(), connection_id).await?;
        ssh_config_from_file_conn(state.inner(), &conn, &cfg).await
    }

    async fn s3_get_bytes(&self, connection_id: &str, key: &str) -> OmniResult<Vec<u8>> {
        let state = app_state(&self.0);
        let (_, cfg, secret) = load_cfg(state.inner(), connection_id).await?;
        s3_get_object_bytes(&cfg, &secret, key).await
    }

    async fn s3_put_bytes(&self, connection_id: &str, key: &str, data: &[u8]) -> OmniResult<()> {
        let state = app_state(&self.0);
        let (_, cfg, secret) = load_cfg(state.inner(), connection_id).await?;
        s3_put_object_bytes(&cfg, &secret, key, data).await
    }

    async fn s3_copy_internal(
        &self,
        connection_id: &str,
        src_key: &str,
        dst_key: &str,
    ) -> OmniResult<()> {
        let state = app_state(&self.0);
        let (_, cfg, secret) = load_cfg(state.inner(), connection_id).await?;
        s3_copy_object_internal(&cfg, &secret, src_key, dst_key).await
    }

    async fn s3_copy_cross_bucket(
        &self,
        source_id: &str,
        src_key: &str,
        dest_id: &str,
        dst_key: &str,
    ) -> OmniResult<()> {
        let state = app_state(&self.0);
        let (_, src_cfg, _) = load_cfg(state.inner(), source_id).await?;
        let (_, dest_cfg, dest_secret) = load_cfg(state.inner(), dest_id).await?;
        s3_copy_object_from_bucket(&dest_cfg, &dest_secret, &src_cfg.bucket, src_key, dst_key).await
    }

    async fn s3_bucket_name(&self, connection_id: &str) -> OmniResult<String> {
        let state = app_state(&self.0);
        let (_, cfg, _) = load_cfg(state.inner(), connection_id).await?;
        Ok(cfg.bucket.clone())
    }

    async fn s3_download_to_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        let key = remote_path.trim_start_matches('/');
        let data = self.s3_get_bytes(connection_id, key).await?;
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::write(local_path, &data).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "写入临时文件失败").with_cause(e.to_string())
        })?;
        Ok(data.len() as u64)
    }

    async fn s3_upload_from_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        let key = remote_path.trim_start_matches('/');
        let data = tokio::fs::read(local_path).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取临时文件失败").with_cause(e.to_string())
        })?;
        let n = data.len() as u64;
        self.s3_put_bytes(connection_id, key, &data).await?;
        Ok(n)
    }

    async fn s3_delete_object(&self, connection_id: &str, key: &str) -> OmniResult<()> {
        let state = app_state(&self.0);
        let (_, cfg, secret) = load_cfg(state.inner(), connection_id).await?;
        s3_delete_object(&cfg, &secret, key).await
    }

    async fn same_s3_bucket_and_endpoint(&self, a: &str, b: &str) -> OmniResult<bool> {
        let state = app_state(&self.0);
        let (_, a_cfg, _) = load_cfg(state.inner(), a).await?;
        let (_, b_cfg, _) = load_cfg(state.inner(), b).await?;
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
        let state = app_state(&self.0);
        let (_, cfg, secret) = load_cfg(state.inner(), connection_id).await?;
        let remote = ftp_remote_path(remote_path, &cfg);
        let local_path = local_path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let mut ftp = ftp_connect_sync(&cfg, &secret)?;
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
        .map_err(|e| {
            OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
        })?
    }

    async fn ftp_upload_from_file(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> OmniResult<u64> {
        let state = app_state(&self.0);
        let (_, cfg, secret) = load_cfg(state.inner(), connection_id).await?;
        let remote = ftp_remote_path(remote_path, &cfg);
        let local_path = local_path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut ftp = ftp_connect_sync(&cfg, &secret)?;
            let parent = Path::new(&remote)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or("/");
            if !parent.is_empty() && parent != "/" {
                let _ = ftp.mkdir(parent);
            }
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
        .map_err(|e| {
            OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
        })?
    }
}

pub fn transfer_host(app: AppHandle) -> Arc<dyn TransferHost> {
    Arc::new(TauriTransferHost(app))
}

pub fn transfer_sink(app: AppHandle) -> Arc<dyn TransferEventSink> {
    Arc::new(TauriTransferSink(app))
}
