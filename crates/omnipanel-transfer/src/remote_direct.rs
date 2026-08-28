//! SFTP↔SFTP 远程直传：数据面不经本机；探测失败或执行失败回落 StreamRelay。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use omnipanel_error::{ErrorCode, OmniError};
use tokio::sync::Mutex;

use crate::event::{TransferEventSink, emit_job};
use crate::provider::{TransferHost, TransferProtocol};
use crate::types::{FileTransferJob, FileTransferState};
use crate::util::{check_cancel, open_sftp};

async fn resolve_sftp_endpoint(
    host: &dyn TransferHost,
    connection_id: &str,
) -> Result<(String, u16, String), OmniError> {
    let ep = host.resolve_sftp_endpoint(connection_id).await?;
    let host_name = ep.host.trim().to_string();
    if host_name.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "目标主机为空"));
    }
    let user = if ep.user.trim().is_empty() {
        "root".into()
    } else {
        ep.user.trim().to_string()
    };
    Ok((host_name, ep.port, user))
}

type ProbeCache = Mutex<std::collections::HashMap<String, (bool, Instant)>>;

static PROBE_CACHE: std::sync::OnceLock<ProbeCache> = std::sync::OnceLock::new();
const PROBE_TTL: Duration = Duration::from_secs(60);

fn probe_cache() -> &'static ProbeCache {
    PROBE_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

pub async fn probe_reachability(
    host: &dyn TransferHost,
    source_connection_id: &str,
    dest_host: &str,
    dest_port: u16,
) -> Result<bool, OmniError> {
    let cache_key = format!("{source_connection_id}|{dest_host}:{dest_port}");
    {
        let cache = probe_cache().lock().await;
        if let Some((ok, at)) = cache.get(&cache_key) {
            if at.elapsed() < PROBE_TTL {
                return Ok(*ok);
            }
        }
    }

    let session = open_sftp(host, source_connection_id).await?;
    let host_q = shell_quote(dest_host);
    let probe_cmd = format!(
        "if command -v nc >/dev/null 2>&1; then nc -z -w 3 {host_q} {dest_port}; \
         elif command -v bash >/dev/null 2>&1; then timeout 3 bash -c 'echo >/dev/tcp/{}/{dest_port}' 2>/dev/null; \
         else timeout 3 sh -c 'exec 3<>/dev/tcp/{}/{dest_port}' 2>/dev/null; fi",
        dest_host.replace('\'', ""),
        dest_host.replace('\'', ""),
    );

    let ok = match session.exec_capture(&probe_cmd).await {
        Ok(out) => out.exit_code == 0,
        Err(_) => false,
    };

    let mut cache = probe_cache().lock().await;
    cache.insert(cache_key, (ok, Instant::now()));
    Ok(ok)
}

fn generate_ephemeral_keypair(work_dir: &Path) -> Result<(PathBuf, PathBuf, String), OmniError> {
    std::fs::create_dir_all(work_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建直传临时目录失败").with_cause(e.to_string())
    })?;
    let priv_path = work_dir.join("id_ed25519");
    let pub_path = work_dir.join("id_ed25519.pub");
    let status = std::process::Command::new("ssh-keygen")
        .args([
            "-t",
            "ed25519",
            "-f",
            priv_path.to_str().unwrap_or("id_ed25519"),
            "-N",
            "",
            "-q",
            "-C",
            "omnipanel-xfer-ephemeral",
        ])
        .status()
        .map_err(|e| {
            OmniError::new(
                ErrorCode::Internal,
                "本机未找到 ssh-keygen，无法创建直传临时密钥",
            )
            .with_cause(e.to_string())
        })?;
    if !status.success() {
        return Err(OmniError::new(
            ErrorCode::Internal,
            "ssh-keygen 生成密钥失败",
        ));
    }
    let pub_text = std::fs::read_to_string(&pub_path)
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取公钥失败").with_cause(e.to_string()))?;
    Ok((priv_path, pub_path, pub_text.trim().to_string()))
}

async fn install_pubkey_on_dest(
    host: &dyn TransferHost,
    dest_connection_id: &str,
    pub_line: &str,
    marker: &str,
) -> Result<String, OmniError> {
    let session = open_sftp(host, dest_connection_id).await?;
    let home = session
        .exec_command("printf %s \"$HOME\"")
        .await
        .unwrap_or_else(|_| "/root".into());
    let ssh_dir = format!("{home}/.ssh");
    let auth_keys = format!("{ssh_dir}/authorized_keys");
    let _ = session
        .exec_command(&format!(
            "mkdir -p {} && chmod 700 {}",
            shell_quote(&ssh_dir),
            shell_quote(&ssh_dir)
        ))
        .await;
    let line = format!("{pub_line} {marker}");
    let cmd = format!(
        "touch {ak} && chmod 600 {ak} && grep -F {m} {ak} >/dev/null 2>&1 || printf '%s\\n' {line} >> {ak}",
        ak = shell_quote(&auth_keys),
        m = shell_quote(marker),
        line = shell_quote(&line),
    );
    session.exec_command(&cmd).await?;
    Ok(auth_keys)
}

async fn remove_pubkey_marker(
    host: &dyn TransferHost,
    dest_connection_id: &str,
    auth_keys: &str,
    marker: &str,
) {
    if let Ok(session) = open_sftp(host, dest_connection_id).await {
        let cmd = format!(
            "if [ -f {ak} ]; then grep -vF {m} {ak} > {ak}.tmp 2>/dev/null && mv {ak}.tmp {ak}; fi",
            ak = shell_quote(auth_keys),
            m = shell_quote(marker),
        );
        let _ = session.exec_command(&cmd).await;
    }
}

async fn place_private_key_on_source(
    host: &dyn TransferHost,
    source_connection_id: &str,
    local_priv: &Path,
    remote_dir: &str,
) -> Result<String, OmniError> {
    let session = open_sftp(host, source_connection_id).await?;
    let _ = session
        .exec_command(&format!(
            "mkdir -p {} && chmod 700 {}",
            shell_quote(remote_dir),
            shell_quote(remote_dir)
        ))
        .await;
    let remote_key = format!("{remote_dir}/id_ed25519");
    session
        .sftp_upload_from_file(&remote_key, local_priv)
        .await?;
    let _ = session
        .exec_command(&format!("chmod 600 {}", shell_quote(&remote_key)))
        .await;
    Ok(remote_key)
}

async fn cleanup_source_key(host: &dyn TransferHost, source_connection_id: &str, remote_dir: &str) {
    if let Ok(session) = open_sftp(host, source_connection_id).await {
        let _ = session
            .exec_command(&format!("rm -rf {}", shell_quote(remote_dir)))
            .await;
    }
}

pub async fn run_remote_direct(
    sink: &dyn TransferEventSink,
    host: &dyn TransferHost,
    job: &mut FileTransferJob,
    cancel: Arc<AtomicBool>,
) -> Result<(), OmniError> {
    if job.source.connection_id == host.local_connection_id()
        || job.dest.connection_id == host.local_connection_id()
    {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "远程直传仅适用于两端均为 SFTP",
        ));
    }
    if job.source.kind == "dir" {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "目录直传请先展开为文件任务",
        ));
    }

    check_cancel(&cancel)?;
    job.state = FileTransferState::Probing;
    emit_job(sink, job).await;

    let (dest_host, dest_port, dest_user) =
        resolve_sftp_endpoint(host, &job.dest.connection_id).await?;

    let reachable =
        probe_reachability(host, &job.source.connection_id, &dest_host, dest_port).await?;
    if !reachable {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("源主机无法连通 {dest_host}:{dest_port}，将回落本机中继"),
        ));
    }

    check_cancel(&cancel)?;
    job.state = FileTransferState::Running;
    job.route_reason = "远程直传（源→宿，数据不经本机）".into();
    emit_job(sink, job).await;

    let marker = format!("omnipanel-xfer-{}", job.id);
    let local_work = std::env::temp_dir()
        .join("omnipanel-xfer-keys")
        .join(&job.id);
    let (priv_path, _pub_path, pub_text) = generate_ephemeral_keypair(&local_work)?;

    let auth_keys =
        install_pubkey_on_dest(host, &job.dest.connection_id, &pub_text, &marker).await?;
    let remote_key_dir = format!("/tmp/omnipanel-xfer-{}", job.id);

    let transfer_result = async {
        check_cancel(&cancel)?;
        let remote_key = place_private_key_on_source(
            host,
            &job.source.connection_id,
            &priv_path,
            &remote_key_dir,
        )
        .await?;

        let session = open_sftp(host, &job.source.connection_id).await?;
        let src_q = shell_quote(&job.source.path);
        let dest_spec = format!("{dest_user}@{dest_host}:{}", job.dest.path);
        let dest_q = shell_quote(&dest_spec);
        let key_q = shell_quote(&remote_key);

        let cmd = format!(
            "if command -v rsync >/dev/null 2>&1; then \
               rsync -a --partial -e \"ssh -i {key_q} -p {dest_port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null\" {src_q} {dest_q}; \
             else \
               scp -i {key_q} -P {dest_port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null {src_q} {dest_q}; \
             fi"
        );
        session.exec_command(&cmd).await?;
        job.progress = 100.0;
        job.bytes_done = job.bytes_total.unwrap_or(1.0);
        emit_job(sink, job).await;
        Ok::<(), OmniError>(())
    }
    .await;

    cleanup_source_key(host, &job.source.connection_id, &remote_key_dir).await;
    remove_pubkey_marker(host, &job.dest.connection_id, &auth_keys, &marker).await;
    let _ = std::fs::remove_dir_all(&local_work);

    transfer_result
}

pub async fn remote_direct_eligible(
    host: &dyn TransferHost,
    source_connection_id: &str,
    dest_connection_id: &str,
) -> bool {
    if source_connection_id == dest_connection_id
        || source_connection_id == host.local_connection_id()
        || dest_connection_id == host.local_connection_id()
    {
        return false;
    }
    let Ok(src) = super::util::resolve_protocol(host, source_connection_id).await else {
        return false;
    };
    let Ok(dst) = super::util::resolve_protocol(host, dest_connection_id).await else {
        return false;
    };
    if src != TransferProtocol::Sftp || dst != TransferProtocol::Sftp {
        return false;
    }
    resolve_sftp_endpoint(host, dest_connection_id)
        .await
        .is_ok()
}
