//! SSH 后端：基于 `russh` + `russh-sftp` 的纯 Rust 实现。
//!
//! - [`SshSession`] 建立连接、请求 PTY + shell channel，I/O 通过单任务 select 循环驱动
//!   （务必持续消费 `channel.wait()`，否则 russh 接收缓冲会饱和导致死锁）。
//! - shell 输出通过 [`SshSink`] 抽象回流，crate 不依赖 Tauri；事件桥接由 `src-tauri` 提供。
//! - SFTP 在独立 channel 上按需打开。

mod connection_config;
mod gpu;
mod openssh_config;
mod process;
mod stats;

pub use gpu::{
    attach_process_gpu, parse_intel_lspci_output, parse_nvidia_gpu_output, parse_nvidia_process_gpu,
    parse_remote_gpu_sections, parse_rocm_smi_output, INTEL_GPU_QUERY, NVIDIA_GPU_QUERY,
    NVIDIA_PROCESS_GPU_QUERY, ROCM_SMI_QUERY,
};
pub use connection_config::ssh_config_from_json;
pub use openssh_config::{
    SshConfigEntry, default_ssh_config_path, default_ssh_dir, discover_ssh_identity_file,
    discover_ssh_identity_file_in, find_ssh_config_entry, list_ssh_private_key_paths,
    list_ssh_private_key_paths_in, load_ssh_config_hosts, load_ssh_config_hosts_from,
    is_private_key_pem_content, ssh_config_to_connect_config, ssh_public_key_meta,
};
pub use process::{
    attach_ports, merge_ports, parse_netstat_ports, parse_ss_ports, parse_windows_netstat_ports,
    SshProcessDetail, SshProcessInfo, SshProcessPort,
};
pub use stats::{
    aggregate_disk_stats, build_memory_stats, compute_cpu_stats, format_load, is_pseudo_filesystem,
    parse_disk_line, parse_disk_lines, parse_memory_triplet, parse_network, parse_proc_stat_sample,
    parse_remote_stats_output, CpuStats, DiskDeviceStats, DiskStats, GpuDeviceStats, GpuStats,
    HostSystemStats, MemoryStats, NetworkStats,
};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key, ssh_key};
use russh::{Channel, ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, mpsc};

/// SSH 认证方式。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshAuth {
    Password {
        password: String,
    },
    PrivateKey {
        #[serde(default)]
        pem: Option<String>,
        #[serde(default, rename = "keyPath", alias = "key_path")]
        key_path: Option<String>,
        passphrase: Option<String>,
    },
}

/// SSH 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub public_ip: Option<String>,
}

fn private_key_candidates_from_auth(
    pem: &Option<String>,
    key_path: &Option<String>,
) -> OmniResult<Vec<(String, String)>> {
    if let Some(value) = pem.as_deref().filter(|value| !value.trim().is_empty()) {
        return Ok(vec![("inline".to_string(), value.to_string())]);
    }

    match key_path.as_deref().filter(|value| !value.trim().is_empty()) {
        Some("auto") | None => {
            let paths = list_ssh_private_key_paths();
            if paths.is_empty() {
                return Err(OmniError::new(
                    ErrorCode::Auth,
                    "未配置 SSH 私钥，且 ~/.ssh 中未找到可用私钥",
                ));
            }

            let mut candidates = Vec::new();
            let mut read_errors = Vec::new();
            for path in paths {
                match std::fs::read_to_string(&path) {
                    Ok(pem) => candidates.push((path.to_string_lossy().to_string(), pem)),
                    Err(e) => read_errors.push(format!("{}: {}", path.display(), e)),
                }
            }
            if candidates.is_empty() {
                return Err(OmniError::new(ErrorCode::Auth, "读取 SSH 私钥失败")
                    .with_cause(read_errors.join("; ")));
            }
            Ok(candidates)
        }
        Some(path) => {
            let path = std::path::PathBuf::from(path);
            let pem = std::fs::read_to_string(&path).map_err(|e| {
                OmniError::new(ErrorCode::Auth, "读取 SSH 私钥失败").with_cause(format!(
                    "{}: {}",
                    path.display(),
                    e
                ))
            })?;
            Ok(vec![(path.to_string_lossy().to_string(), pem)])
        }
    }
}

async fn authenticate_private_key(
    session: &mut client::Handle<Client>,
    user: &str,
    pem: &Option<String>,
    key_path: &Option<String>,
    passphrase: &Option<String>,
) -> OmniResult<bool> {
    let candidates = private_key_candidates_from_auth(pem, key_path)?;
    let hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Ssh, "协商 RSA 哈希失败").with_cause(e.to_string()))?
        .flatten();

    let mut attempted = false;
    let mut last_error: Option<String> = None;
    for (label, key_pem) in candidates {
        let key = match decode_secret_key(&key_pem, passphrase.as_deref()) {
            Ok(key) => key,
            Err(e) => {
                last_error = Some(format!("{label}: 私钥解析失败: {e}"));
                continue;
            }
        };
        attempted = true;
        let result = session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Auth, "SSH 公钥认证失败")
                    .with_cause(format!("{label}: {e}"))
            })?;
        if result.success() {
            return Ok(true);
        }
        last_error = Some(format!("{label}: SSH 公钥认证被拒绝"));
    }

    let message = if attempted {
        "SSH 公钥认证被拒绝"
    } else {
        "SSH 私钥解析失败"
    };
    Err(OmniError::new(ErrorCode::Auth, message)
        .with_cause(last_error.unwrap_or_else(|| "没有可用私钥".into())))
}

/// 密码认证：先 `password`，失败则回退 `keyboard-interactive`（许多 Linux 仅开放后者）。
async fn authenticate_with_password(
    session: &mut client::Handle<Client>,
    user: &str,
    password: &str,
) -> OmniResult<()> {
    if let Ok(result) = session.authenticate_password(user, password).await {
        if result.success() {
            return Ok(());
        }
    }

    let mut response = session
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Auth, "SSH 键盘交互认证失败").with_cause(e.to_string())
        })?;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(OmniError::new(ErrorCode::Auth, "SSH 密码认证被拒绝"));
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers: Vec<String> = prompts.iter().map(|_| password.to_string()).collect();
                response = session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| {
                        OmniError::new(ErrorCode::Auth, "SSH 键盘交互认证失败")
                            .with_cause(e.to_string())
                    })?;
            }
        }
    }
}

/// SFTP 目录项。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub link_target: Option<String>,
    #[specta(type = f64)]
    pub size: u64,
}

fn sftp_join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn normalize_sftp_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn resolve_sftp_link_target(link_path: &str, target: &str) -> String {
    if target.starts_with('/') {
        normalize_sftp_path(target)
    } else {
        let parent = match link_path.rfind('/') {
            Some(0) => "/",
            Some(index) => &link_path[..index],
            None => "/",
        };
        let joined = if parent == "/" {
            format!("/{target}")
        } else {
            format!("{parent}/{target}")
        };
        normalize_sftp_path(&joined)
    }
}

/// 非交互命令执行结果（exec channel，独立于交互 shell）。
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl ExecOutput {
    /// 退出码非 0 时返回错误（附带 stderr/stdout 作为原因）。
    pub fn ok_or_err(self, context: &str) -> OmniResult<Self> {
        if self.exit_code == 0 {
            Ok(self)
        } else {
            let detail = if self.stderr.trim().is_empty() {
                self.stdout.clone()
            } else {
                self.stderr.clone()
            };
            Err(OmniError::new(ErrorCode::Internal, context.to_string())
                .with_cause(detail.trim().to_string()))
        }
    }
}

/// shell channel 的输出事件。
#[derive(Debug, Clone)]
pub enum SshEvent {
    /// 终端输出字节
    Data(Vec<u8>),
    /// 远端进程退出
    Exit(Option<u32>),
    /// 连接断开
    Disconnected,
}

/// 输出回调抽象。`src-tauri` 注入「emit 到 terminal-output 事件」的实现。
pub type SshSink = Arc<dyn Fn(SshEvent) + Send + Sync>;

/// exec 流式通道的输出块。
#[derive(Debug, Clone)]
pub enum StreamChunk {
    /// 标准输出
    Stdout(Vec<u8>),
    /// 标准错误
    Stderr(Vec<u8>),
    /// 远端进程退出码
    Exit(i32),
    /// 通道被主动关闭
    Closed,
}

impl StreamChunk {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::Stdout(b) | Self::Stderr(b) => b,
            _ => &[],
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Exit(_) | Self::Closed)
    }
}

/// exec 流式通道句柄。`stop()` 立即关闭底层 SSH channel，停止读任务并触发 `Closed` chunk。
pub struct SshStreamHandle {
    stop: Arc<AtomicBool>,
    _task: Option<tokio::task::JoinHandle<()>>,
}

impl SshStreamHandle {
    /// 主动停止：置 stop flag 并等待读任务结束。
    pub async fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(task) = self._task.take() {
            let _ = task.await;
        }
    }

    /// 仅置 stop flag，不等任务结束（用于 fire-and-forget 的 UI 流停止）。
    pub fn signal_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for SshStreamHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// PTY exec 通道输出（与 `StreamChunk` 同义，分开名字以保持可读性）。
pub type PtyChunk = StreamChunk;

enum PtyMsg {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// PTY exec 会话：可写 stdin、可 resize、可流式读取 stdout/stderr。
/// 用于 `docker exec -it <id> /bin/sh` 这类需要 TTY 的交互式容器终端。
pub struct SshPtySession {
    tx: mpsc::UnboundedSender<PtyMsg>,
    stop: Arc<AtomicBool>,
    _task: Option<tokio::task::JoinHandle<()>>,
}

impl SshPtySession {
    /// 写 stdin。
    pub async fn write(&self, data: &[u8]) -> OmniResult<()> {
        self.tx
            .send(PtyMsg::Data(data.to_vec()))
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "PTY 会话已关闭，无法写入"))
    }

    /// 调整 PTY 尺寸。
    pub async fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        self.tx
            .send(PtyMsg::Resize(cols, rows))
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "PTY 会话已关闭，无法调整尺寸"))
    }

    /// 主动关闭会话：通知 PTY 任务退出，由任务统一关闭 SSH channel。
    pub async fn close(mut self) -> OmniResult<()> {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.tx.send(PtyMsg::Close);
        if let Some(task) = self._task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(8), task).await;
        }
        Ok(())
    }
}

impl Drop for SshPtySession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.tx.send(PtyMsg::Close);
    }
}

/// 读任务的实际逻辑：循环消费 channel 数据，按通道类型发往 tx，结束时关闭 channel。
async fn close_exec_channel(channel: &mut Channel<russh::client::Msg>) {
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

async fn run_stream_task(
    channel: &mut Channel<russh::client::Msg>,
    tx: mpsc::UnboundedSender<StreamChunk>,
    stop: Arc<AtomicBool>,
) {
    let mut exit_code: i32 = 0;
    let mut saw_exit = false;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        if tx.send(StreamChunk::Stdout(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, ext }) => {
                        let chunk = if ext == 1 {
                            StreamChunk::Stderr(data.to_vec())
                        } else {
                            StreamChunk::Stdout(data.to_vec())
                        };
                        if tx.send(chunk).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = exit_status as i32;
                        saw_exit = true;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        break;
                    }
                    _ => {}
                }
            }
            _ = wait_stop(&stop) => {
                break;
            }
        }
    }
    close_exec_channel(channel).await;
    if saw_exit {
        let _ = tx.send(StreamChunk::Exit(exit_code));
    } else {
        let _ = tx.send(StreamChunk::Closed);
    }
}

async fn run_pty_task(
    channel: &mut Channel<russh::client::Msg>,
    tx: mpsc::UnboundedSender<StreamChunk>,
    mut rx: mpsc::UnboundedReceiver<PtyMsg>,
    stop: Arc<AtomicBool>,
) {
    let mut exit_code: i32 = 0;
    let mut saw_exit = false;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        if tx.send(StreamChunk::Stdout(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, ext }) => {
                        let chunk = if ext == 1 {
                            StreamChunk::Stderr(data.to_vec())
                        } else {
                            StreamChunk::Stdout(data.to_vec())
                        };
                        if tx.send(chunk).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = exit_status as i32;
                        saw_exit = true;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        break;
                    }
                    _ => {}
                }
            }
            msg = rx.recv() => {
                match msg {
                    Some(PtyMsg::Data(data)) => {
                        if channel.data(data.as_slice()).await.is_err() {
                            break;
                        }
                    }
                    Some(PtyMsg::Resize(cols, rows)) => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Some(PtyMsg::Close) | None => {
                        break;
                    }
                }
            }
            _ = wait_stop(&stop) => {
                break;
            }
        }
    }
    close_exec_channel(channel).await;
    if saw_exit {
        let _ = tx.send(StreamChunk::Exit(exit_code));
    } else {
        let _ = tx.send(StreamChunk::Closed);
    }
}

async fn wait_stop(stop: &AtomicBool) {
    while !stop.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 会话已死时重试 `channel_open_session` 无意义，应立刻失败并让上层重建连接。
/// 注意：单纯的 `Eof` / `ChannelOpenFailure` 仍可能是瞬时抖动，留给退避重试。
fn is_ssh_session_dead_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("channel send")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("connection is closed")
        || lower.contains("broken pipe")
        || lower.contains("not connected")
}

/// 打开一个新 exec/SFTP channel，并对 `channel_open_session` 短暂失败做有限重试。
///
/// `russh` 的 `channel_open_session` 在底层 TCP/SSH 出现瞬时抖动时会偶发返回
/// `Eof` / `ConnectionReset` / `ChannelOpenFailure`，绝大多数情况下短暂等待后
/// 再次调用即可成功。这里最多重试 `attempts` 次（默认 3），退避 100/200/400ms。
/// 若仍然失败，把最后一次的原始错误透传给调用方。
async fn open_session_channel_retry(
    session: &client::Handle<Client>,
    attempts: u32,
) -> OmniResult<Channel<russh::client::Msg>> {
    let mut last_err: Option<String> = None;
    for attempt in 0..attempts {
        match session.channel_open_session().await {
            Ok(channel) => return Ok(channel),
            Err(e) => {
                let err_str = e.to_string();
                last_err = Some(err_str.clone());
                // 连接已断：继续退避只会拖慢 Docker/侧栏恢复
                if is_ssh_session_dead_error(&err_str) {
                    break;
                }
                if attempt + 1 < attempts {
                    let delay = Duration::from_millis(100u64 << attempt);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(OmniError::new(ErrorCode::Ssh, "打开 SSH 通道失败")
        .with_cause(last_err.unwrap_or_else(|| "未知错误".into())))
}

const CHANNEL_OPEN_ATTEMPTS: u32 = 3;

#[cfg(test)]
/// 同步「指数退避 + 有限重试」辅助：调用 `op` 最多 `attempts` 次，
/// 第一次成功立刻返回 `Ok(Some(value))`；若中途一直失败，返回最后一次的
/// 错误。仅适用于返回 `Result<T, E>` 的同步闭包，async 版本用
/// `open_session_channel_retry` 之类的专用包装。
async fn retry_with_backoff<T, E, F>(op: &mut F, attempts: u32) -> OmniResult<Option<T>>
where
    E: std::fmt::Display,
    F: FnMut() -> Result<T, E>,
{
    let mut last_err: Option<String> = None;
    for attempt in 0..attempts {
        match op() {
            Ok(value) => return Ok(Some(value)),
            Err(e) => {
                last_err = Some(e.to_string());
                if attempt + 1 < attempts {
                    let delay = Duration::from_millis(100u64 << attempt);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(OmniError::new(ErrorCode::Ssh, "操作重试耗尽")
        .with_cause(last_err.unwrap_or_else(|| "未知错误".into())))
}

/// 接受任意服务器公钥的 handler（MVP；后续应接入 known_hosts 校验）。
struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 发给 shell I/O 任务的消息。
enum ShellMsg {
    Data(Vec<u8>),
    Resize(u16, u16),
}

/// 一个已建立的 SSH 会话：持有 client handle（用于 SFTP）与 shell 输入通道。
/// 当 `shell_tx` 为 None 时仅支持 `exec_command` / SFTP 操作（连接池模式）。
pub struct SshSession {
    session: client::Handle<Client>,
    shell_tx: Option<mpsc::UnboundedSender<ShellMsg>>,
    /// 串行化同连接上的 exec/SFTP channel（russh Handle 不支持并发 `channel_open_session`）。
    exec_gate: Arc<Semaphore>,
}

impl SshSession {
    /// 建立连接、认证、请求 PTY + shell，并启动 I/O 任务。
    pub async fn connect(
        config: SshConfig,
        cols: u16,
        rows: u16,
        sink: SshSink,
    ) -> OmniResult<Self> {
        let client_config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(3600)),
            ..Default::default()
        });

        let mut session =
            client::connect(client_config, (config.host.as_str(), config.port), Client)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Connection, "SSH 连接失败").with_cause(e.to_string())
                })?;

        match &config.auth {
            SshAuth::Password { password } => {
                authenticate_with_password(&mut session, &config.user, password).await?;
            }
            SshAuth::PrivateKey {
                pem,
                key_path,
                passphrase,
            } => {
                if !authenticate_private_key(&mut session, &config.user, pem, key_path, passphrase)
                    .await?
                {
                    return Err(OmniError::new(ErrorCode::Auth, "SSH 认证被拒绝"));
                }
            }
        }

        let mut channel = open_session_channel_retry(&session, CHANNEL_OPEN_ATTEMPTS).await?;
        channel
            .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Ssh, "请求 PTY 失败").with_cause(e.to_string())
            })?;
        channel.request_shell(true).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "请求 shell 失败").with_cause(e.to_string())
        })?;

        let (shell_tx, mut shell_rx) = mpsc::unbounded_channel::<ShellMsg>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = shell_rx.recv() => {
                        match msg {
                            Some(ShellMsg::Data(data)) => {
                                if channel.data(&data[..]).await.is_err() {
                                    break;
                                }
                            }
                            Some(ShellMsg::Resize(c, r)) => {
                                let _ = channel.window_change(c as u32, r as u32, 0, 0).await;
                            }
                            None => break, // 发送端全部 drop，会话关闭
                        }
                    }
                    chan_msg = channel.wait() => {
                        match chan_msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                sink(SshEvent::Data(data.to_vec()));
                            }
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                sink(SshEvent::Data(data.to_vec()));
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                sink(SshEvent::Exit(Some(exit_status)));
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
            sink(SshEvent::Disconnected);
        });

        Ok(Self {
            session,
            shell_tx: Some(shell_tx),
            exec_gate: Arc::new(Semaphore::new(1)),
        })
    }

    /// 建立连接并认证，但不请求 PTY/shell。
    /// 适用于连接池、监控等只需 exec_command 的场景。
    pub async fn connect_no_shell(config: SshConfig) -> OmniResult<Self> {
        let client_config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(3600)),
            ..Default::default()
        });

        let mut session =
            client::connect(client_config, (config.host.as_str(), config.port), Client)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Connection, "SSH 连接失败").with_cause(e.to_string())
                })?;

        match &config.auth {
            SshAuth::Password { password } => {
                authenticate_with_password(&mut session, &config.user, password).await?;
            }
            SshAuth::PrivateKey {
                pem,
                key_path,
                passphrase,
            } => {
                if !authenticate_private_key(&mut session, &config.user, pem, key_path, passphrase)
                    .await?
                {
                    return Err(OmniError::new(ErrorCode::Auth, "SSH 认证被拒绝"));
                }
            }
        }

        Ok(Self {
            session,
            shell_tx: None,
            exec_gate: Arc::new(Semaphore::new(1)),
        })
    }

    /// 写入 shell 输入。
    pub fn write(&self, data: &[u8]) -> OmniResult<()> {
        self.shell_tx
            .as_ref()
            .ok_or_else(|| {
                OmniError::new(ErrorCode::Ssh, "当前会话不支持 shell 输入（连接池模式）")
            })?
            .send(ShellMsg::Data(data.to_vec()))
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 会话已关闭"))
    }

    /// 调整远端 PTY 窗口大小。
    pub fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        self.shell_tx
            .as_ref()
            .ok_or_else(|| {
                OmniError::new(ErrorCode::Ssh, "当前会话不支持 shell 输入（连接池模式）")
            })?
            .send(ShellMsg::Resize(cols, rows))
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 会话已关闭"))
    }

    /// 在独立 exec channel 上运行一条命令并捕获 stdout/stderr 与退出码。
    /// 不影响交互 shell channel，可与之并存（Docker SSH adapter 用于调用远端 `docker` CLI）。
    pub async fn exec_capture(&self, command: &str) -> OmniResult<ExecOutput> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH exec 资源不可用"))?;

        // 与 exec_stream / exec_pty 一致：走带退避的 open，避免瞬时抖动直接打到前端
        let mut channel = open_session_channel_retry(&self.session, CHANNEL_OPEN_ATTEMPTS)
            .await
            .map_err(|e| e.or_ssh_context("打开 SSH exec 通道失败"))?;

        let result: OmniResult<ExecOutput> = async {
            channel.exec(true, command).await.map_err(|e| {
                OmniError::new(ErrorCode::Ssh, "发起 SSH 命令失败").with_cause(e.to_string())
            })?;

            let mut stdout: Vec<u8> = Vec::new();
            let mut stderr: Vec<u8> = Vec::new();
            let mut exit_code: i32 = 0;

            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                    ChannelMsg::ExtendedData { ref data, ext } => {
                        // ext == 1 为 stderr，其余并入 stdout。
                        if ext == 1 {
                            stderr.extend_from_slice(data);
                        } else {
                            stdout.extend_from_slice(data);
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status as i32,
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }

            Ok(ExecOutput {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                exit_code,
            })
        }
        .await;

        close_exec_channel(&mut channel).await;
        result
    }

    /// 在独立 exec channel 上以流式方式运行命令，stdout/stderr 实时写入 `tx`。
    /// 返回 [`SshStreamHandle`]，调用方 `stop()` 即可中止远端命令。
    ///
    /// `exec_gate` 仅串行化 channel 打开；通道建立后立即释放，避免日志流 / 长命令
    /// 阻塞同会话上的 `docker stats` 等短命令（否则前端会 45s 超时）。
    pub async fn exec_stream(
        &self,
        command: &str,
        tx: mpsc::UnboundedSender<StreamChunk>,
    ) -> OmniResult<SshStreamHandle> {
        let exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH exec 资源不可用"))?;

        let mut channel = open_session_channel_retry(&self.session, CHANNEL_OPEN_ATTEMPTS)
            .await
            .map_err(|e| e.or_ssh_context("打开 SSH exec 通道失败"))?;
        if let Err(e) = channel.exec(true, command).await {
            close_exec_channel(&mut channel).await;
            return Err(
                OmniError::new(ErrorCode::Ssh, "发起 SSH 命令失败").with_cause(e.to_string())
            );
        }
        // 通道已打开：释放闸门，允许多个已建立 channel 并存
        drop(exec_permit);

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();

        let task = tokio::spawn(async move {
            run_stream_task(&mut channel, tx, stop_clone).await;
        });

        Ok(SshStreamHandle {
            stop,
            _task: Some(task),
        })
    }

    /// 在独立 exec channel 上以 PTY 模式运行命令，返回 [`SshPtySession`] 用于交互式终端。
    /// 适用于 `docker exec -it <id> /bin/sh` 这类需要 TTY 的场景。
    /// 命令输出以 `StreamChunk` 形式经 `tx` 推送。
    ///
    /// 与 [`Self::exec_stream`] 相同：仅在打开 channel 期间占用 `exec_gate`。
    pub async fn exec_pty(
        &self,
        command: &str,
        cols: u16,
        rows: u16,
        tx: mpsc::UnboundedSender<StreamChunk>,
    ) -> OmniResult<SshPtySession> {
        let exec_permit = tokio::time::timeout(
            Duration::from_secs(15),
            self.exec_gate.clone().acquire_owned(),
        )
        .await
        .map_err(|_| {
            OmniError::new(
                ErrorCode::Ssh,
                "等待 SSH exec 资源超时，请稍后重试",
            )
        })?
        .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH exec 资源不可用"))?;

        let mut channel = open_session_channel_retry(&self.session, CHANNEL_OPEN_ATTEMPTS)
            .await
            .map_err(|e| e.or_ssh_context("打开 SSH PTY 通道失败"))?;
        if let Err(e) = channel
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
        {
            close_exec_channel(&mut channel).await;
            return Err(OmniError::new(ErrorCode::Ssh, "请求 PTY 失败").with_cause(e.to_string()));
        }
        if let Err(e) = channel.exec(true, command).await {
            close_exec_channel(&mut channel).await;
            return Err(
                OmniError::new(ErrorCode::Ssh, "发起 PTY exec 命令失败").with_cause(e.to_string())
            );
        }
        drop(exec_permit);

        let (pty_tx, pty_rx) = mpsc::unbounded_channel::<PtyMsg>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let task = tokio::spawn(async move {
            run_pty_task(&mut channel, tx, pty_rx, stop_clone).await;
        });

        Ok(SshPtySession {
            tx: pty_tx,
            stop,
            _task: Some(task),
        })
    }

    /// 在独立 exec channel 上运行命令并返回 stdout 文本。
    pub async fn exec_command(&self, command: &str) -> OmniResult<String> {
        let output = self.exec_capture(command).await?;
        if output.exit_code != 0 {
            let detail = if output.stderr.trim().is_empty() {
                output.stdout.trim()
            } else {
                output.stderr.trim()
            };
            return Err(OmniError::new(ErrorCode::Ssh, "远程命令返回非零退出码")
                .with_cause(format!("exit={} stderr={detail}", output.exit_code)));
        }
        Ok(output.stdout.trim().to_string())
    }

    /// 主动断开连接。
    pub async fn disconnect(&self) {
        let _ = self
            .session
            .disconnect(Disconnect::ByApplication, "", "")
            .await;
    }

    async fn open_sftp_inner(&self) -> OmniResult<SftpSession> {
        let channel = open_session_channel_retry(&self.session, CHANNEL_OPEN_ATTEMPTS)
            .await
            .map_err(|e| e.or_ssh_context("打开 SFTP 通道失败"))?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "请求 SFTP 子系统失败").with_cause(e.to_string())
        })?;
        SftpSession::new(channel.into_stream()).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "初始化 SFTP 会话失败").with_cause(e.to_string())
        })
    }

    /// 列出远端目录。
    pub async fn sftp_list(&self, path: &str) -> OmniResult<Vec<SftpEntry>> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        let dir = sftp.read_dir(path).await.map_err(|e| {
            let err_str = e.to_string();
            let msg =
                if err_str.contains("Permission denied") || err_str.contains("permission denied") {
                    "权限不足，无法读取此目录"
                } else {
                    "读取目录失败"
                };
            OmniError::new(ErrorCode::Ssh, msg).with_cause(err_str)
        })?;
        let mut entries = Vec::new();
        for entry in dir {
            let meta = entry.metadata();
            let file_type = meta.file_type();
            let is_symlink = file_type.is_symlink();
            let mut is_dir = file_type.is_dir();
            let mut link_target = None;

            if is_symlink {
                let entry_path = sftp_join_path(path, &entry.file_name());
                if let Ok(target) = sftp.read_link(&entry_path).await {
                    link_target = Some(target.clone());
                    let resolved = resolve_sftp_link_target(&entry_path, &target);
                    if let Ok(target_meta) = sftp.metadata(&resolved).await {
                        is_dir = target_meta.file_type().is_dir();
                    } else if target.ends_with('/') {
                        is_dir = true;
                    }
                }
            }

            entries.push(SftpEntry {
                name: entry.file_name(),
                is_dir,
                is_symlink,
                link_target,
                size: meta.size.unwrap_or(0),
            });
        }
        Ok(entries)
    }

    /// 下载远端文件内容。
    pub async fn sftp_download(&self, path: &str) -> OmniResult<Vec<u8>> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        sftp.read(path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "下载文件失败").with_cause(e.to_string()))
    }

    /// 将远端文件流式写入本地路径（分块拷贝，避免整文件进内存）。
    pub async fn sftp_download_to_file(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
    ) -> OmniResult<()> {
        use tokio::io::AsyncWriteExt;

        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        let mut remote = sftp.open(remote_path).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开远端文件失败").with_cause(e.to_string())
        })?;
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "创建本地缓存目录失败").with_cause(e.to_string())
            })?;
        }
        let mut local = tokio::fs::File::create(local_path).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "创建本地缓存文件失败").with_cause(e.to_string())
        })?;
        tokio::io::copy(&mut remote, &mut local).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "下载文件失败").with_cause(e.to_string())
        })?;
        local.flush().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "写入本地缓存失败").with_cause(e.to_string())
        })?;
        Ok(())
    }

    /// 按偏移读取远端文件一段（用于探测媒体头，不整文件下载）。
    pub async fn sftp_read_range(
        &self,
        remote_path: &str,
        offset: u64,
        len: u32,
    ) -> OmniResult<Vec<u8>> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        let mut remote = sftp.open(remote_path).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开远端文件失败").with_cause(e.to_string())
        })?;
        if offset > 0 {
            remote
                .seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Ssh, "定位远端文件失败").with_cause(e.to_string())
                })?;
        }
        let take = len.min(4 * 1024 * 1024) as usize;
        let mut buf = vec![0u8; take];
        let n = remote.read(&mut buf).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "读取远端文件失败").with_cause(e.to_string())
        })?;
        buf.truncate(n);
        Ok(buf)
    }

    /// 远端文件大小（字节）；失败返回 None。
    pub async fn sftp_file_size(&self, remote_path: &str) -> Option<u64> {
        let _exec_permit = self.exec_gate.clone().acquire_owned().await.ok()?;
        let sftp = self.open_sftp_inner().await.ok()?;
        let meta = sftp.metadata(remote_path).await.ok()?;
        meta.size
    }

    /// 上传内容到远端文件（覆盖）。
    pub async fn sftp_upload(&self, path: &str, data: &[u8]) -> OmniResult<()> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        sftp.write(path, data)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "上传文件失败").with_cause(e.to_string()))
    }

    pub async fn sftp_mkdir(&self, path: &str) -> OmniResult<()> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        sftp.create_dir(path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "创建目录失败").with_cause(e.to_string()))
    }

    pub async fn sftp_remove(&self, path: &str) -> OmniResult<()> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        sftp.remove_file(path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "删除失败").with_cause(e.to_string()))
    }

    /// 重命名远程文件/目录。
    pub async fn sftp_rename(&self, old_path: &str, new_path: &str) -> OmniResult<()> {
        let _exec_permit = self
            .exec_gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 资源繁忙，请稍后重试"))?;
        let sftp = self.open_sftp_inner().await?;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "重命名失败").with_cause(e.to_string()))
    }

    /// 修改远程文件权限（通过 exec chmod）。
    pub async fn sftp_chmod(&self, path: &str, mode: u32) -> OmniResult<()> {
        let cmd = format!("chmod {:o} {}", mode, path);
        self.exec_capture(&cmd).await?.ok_or_err("chmod 失败")?;
        Ok(())
    }

    /// 仅拉取进程列表（不采集端口，用于快速刷新）。
    pub async fn process_list_fast(&self) -> OmniResult<Vec<SshProcessInfo>> {
        use crate::process::{parse_ps_output, PS_LIST_SCRIPT, PS_AUX_CMD, PS_EO_CMD};

        if let Ok(output) = self.exec_capture(PS_LIST_SCRIPT).await {
            if !output.stdout.trim().is_empty() {
                return Ok(parse_ps_output(&output.stdout));
            }
        }

        for cmd in [PS_EO_CMD, PS_AUX_CMD] {
            match self.exec_capture(cmd).await {
                Ok(output) if !output.stdout.trim().is_empty() => {
                    return Ok(parse_ps_output(&output.stdout));
                }
                _ => continue,
            }
        }

        Err(OmniError::new(ErrorCode::Ssh, "获取进程列表失败")
            .with_cause("远程 ps 命令无输出或不可用"))
    }

    /// 通过 `/proc/<pid>` 深入查询启动命令、工作目录、可执行文件和打开文件。
    pub async fn process_detail(&self, pid: u32) -> OmniResult<SshProcessDetail> {
        use crate::process::{parse_process_detail_output, process_detail_cmd};

        let output = self
            .exec_command(&process_detail_cmd(pid))
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Ssh, "获取进程详情失败").with_cause(e.to_string())
            })?;
        Ok(parse_process_detail_output(pid, &output))
    }

    /// 采集监听端口映射（优先 ss/netstat，必要时短超时 /proc 回退）。
    pub async fn collect_listen_ports(
        &self,
    ) -> OmniResult<std::collections::HashMap<u32, Vec<crate::process::SshProcessPort>>> {
        use std::collections::HashMap;
        use std::time::Duration;

        use crate::process::{
            COLLECT_PORTS_CMD, NETSTAT_CMD, SS_CMD, SS_CMD_NO_HEADER, merge_ports,
            parse_netstat_ports, parse_proc_ports, parse_ss_ports,
        };

        let mut ports_by_pid: HashMap<u32, Vec<crate::process::SshProcessPort>> = HashMap::new();

        for cmd in [SS_CMD, SS_CMD_NO_HEADER, NETSTAT_CMD] {
            let stdout = match self.exec_capture(cmd).await {
                Ok(out) => out.stdout,
                Err(_) => continue,
            };
            if stdout.trim().is_empty() {
                continue;
            }
            let parsed = if cmd == NETSTAT_CMD {
                parse_netstat_ports(&stdout)
            } else {
                parse_ss_ports(&stdout)
            };
            merge_ports(&mut ports_by_pid, parsed);
        }

        if ports_by_pid.is_empty() {
            match tokio::time::timeout(Duration::from_secs(8), self.exec_capture(COLLECT_PORTS_CMD))
                .await
            {
                Ok(Ok(out)) if !out.stdout.trim().is_empty() => {
                    merge_ports(&mut ports_by_pid, parse_proc_ports(&out.stdout));
                }
                _ => {}
            }
        }

        Ok(ports_by_pid)
    }

    /// 列出远程进程列表（优先 ps -eo，回退 ps aux，并关联监听端口）。
    pub async fn process_list(&self) -> OmniResult<Vec<SshProcessInfo>> {
        use crate::process::attach_ports;

        let mut processes = self.process_list_fast().await?;
        let ports_by_pid = self.collect_listen_ports().await.unwrap_or_default();
        attach_ports(&mut processes, &ports_by_pid);
        Ok(processes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_serde_roundtrip() {
        let cfg = SshConfig {
            host: "example.com".into(),
            port: 22,
            user: "deploy".into(),
            public_ip: None,
            auth: SshAuth::Password {
                password: "secret".into(),
            },
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SshConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "example.com");
        assert_eq!(back.port, 22);
        assert!(matches!(back.auth, SshAuth::Password { .. }));
    }

    #[test]
    fn private_key_auth_serde() {
        let json = r#"{"host":"h","port":2222,"user":"u","auth":{"type":"privateKey","pem":"KEY","passphrase":null}}"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, 2222);
        assert!(matches!(cfg.auth, SshAuth::PrivateKey { .. }));
    }

    #[tokio::test]
    async fn retry_returns_immediately_on_first_success() {
        let mut calls = 0;
        let mut op = || -> Result<&'static str, String> {
            calls += 1;
            Ok("ok")
        };
        let result = retry_with_backoff(&mut op, 3).await;
        assert_eq!(calls, 1);
        assert_eq!(result.unwrap(), Some("ok"));
    }

    #[tokio::test]
    async fn retry_recovers_after_transient_failures() {
        let mut calls = 0;
        let mut op = || -> Result<&'static str, String> {
            calls += 1;
            if calls < 3 {
                Err(format!("transient #{calls}"))
            } else {
                Ok("recovered")
            }
        };
        let result = retry_with_backoff(&mut op, 3).await;
        assert_eq!(calls, 3);
        assert_eq!(result.unwrap(), Some("recovered"));
    }

    #[tokio::test]
    async fn retry_exhausts_and_surfaces_last_error() {
        let mut calls = 0;
        let mut op = || -> Result<&'static str, String> {
            calls += 1;
            Err(format!("always-fail #{calls}"))
        };
        let err = retry_with_backoff(&mut op, 3).await.unwrap_err();
        assert_eq!(calls, 3);
        assert!(err.cause.as_deref().unwrap_or("").contains("always-fail #3"));
    }
}
