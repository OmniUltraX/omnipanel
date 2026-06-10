//! SSH 后端：基于 `russh` + `russh-sftp` 的纯 Rust 实现。
//!
//! - [`SshSession`] 建立连接、请求 PTY + shell channel，I/O 通过单任务 select 循环驱动
//!   （务必持续消费 `channel.wait()`，否则 russh 接收缓冲会饱和导致死锁）。
//! - shell 输出通过 [`SshSink`] 抽象回流，crate 不依赖 Tauri；事件桥接由 `src-tauri` 提供。
//! - SFTP 在独立 channel 上按需打开。

mod openssh_config;

pub use openssh_config::{
    SshConfigEntry, default_ssh_config_path, find_ssh_config_entry, load_ssh_config_hosts,
    load_ssh_config_hosts_from, ssh_config_to_connect_config,
};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key, ssh_key};
use russh::{Channel, ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// SSH 认证方式。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshAuth {
    Password {
        password: String,
    },
    PrivateKey {
        pem: String,
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
}

/// SFTP 目录项。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    #[specta(type = f64)]
    pub size: u64,
}

/// 远程进程信息（ps aux 解析结果）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshProcessInfo {
    pub user: String,
    pub pid: u32,
    pub cpu: f64,
    pub mem: f64,
    #[specta(type = f64)]
    pub vsz: u64,
    #[specta(type = f64)]
    pub rss: u64,
    pub stat: String,
    pub start: String,
    pub time: String,
    pub command: String,
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

/// PTY exec 会话：可写 stdin、可 resize、可流式读取 stdout/stderr。
/// 用于 `docker exec -it <id> /bin/sh` 这类需要 TTY 的交互式容器终端。
pub struct SshPtySession {
    channel: Arc<tokio::sync::Mutex<Channel<russh::client::Msg>>>,
    stop: Arc<AtomicBool>,
    _task: Option<tokio::task::JoinHandle<()>>,
}

impl SshPtySession {
    /// 写 stdin。
    pub async fn write(&self, data: &[u8]) -> OmniResult<()> {
        let ch = self.channel.lock().await;
        ch.data(data)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "写入 PTY stdin 失败").with_cause(e.to_string()))
    }

    /// 调整 PTY 尺寸。
    pub async fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        let ch = self.channel.lock().await;
        ch.window_change(cols as u32, rows as u32, 0, 0)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "调整 PTY 尺寸失败").with_cause(e.to_string()))
    }

    /// 主动关闭会话。
    pub async fn close(mut self) -> OmniResult<()> {
        self.stop.store(true, Ordering::Relaxed);
        {
            let ch = self.channel.lock().await;
            let _ = ch.eof().await;
            let _ = ch.close().await;
        }
        if let Some(task) = self._task.take() {
            let _ = task.await;
        }
        Ok(())
    }
}

/// 读任务的实际逻辑：循环消费 channel 数据，按通道类型发往 tx，stop 触发时关闭 channel。
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
                let _ = channel.eof().await;
                let _ = channel.close().await;
                break;
            }
        }
    }
    if saw_exit {
        let _ = tx.send(StreamChunk::Exit(exit_code));
    } else {
        let _ = tx.send(StreamChunk::Closed);
    }
}

async fn wait_stop(stop: &AtomicBool) {
    // 简单轮询：100ms 一次，足够 UI 流式跟随的颗粒度。
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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

        let auth_ok = match &config.auth {
            SshAuth::Password { password } => session
                .authenticate_password(&config.user, password)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Auth, "SSH 密码认证失败").with_cause(e.to_string())
                })?
                .success(),
            SshAuth::PrivateKey { pem, passphrase } => {
                let key = decode_secret_key(pem, passphrase.as_deref()).map_err(|e| {
                    OmniError::new(ErrorCode::Auth, "SSH 私钥解析失败").with_cause(e.to_string())
                })?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| {
                        OmniError::new(ErrorCode::Ssh, "协商 RSA 哈希失败")
                            .with_cause(e.to_string())
                    })?
                    .flatten();
                session
                    .authenticate_publickey(
                        &config.user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| {
                        OmniError::new(ErrorCode::Auth, "SSH 公钥认证失败")
                            .with_cause(e.to_string())
                    })?
                    .success()
            }
        };

        if !auth_ok {
            return Err(OmniError::new(ErrorCode::Auth, "SSH 认证被拒绝"));
        }

        let mut channel = session.channel_open_session().await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开 SSH 会话通道失败").with_cause(e.to_string())
        })?;
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

        let auth_ok = match &config.auth {
            SshAuth::Password { password } => session
                .authenticate_password(&config.user, password)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Auth, "SSH 密码认证失败").with_cause(e.to_string())
                })?
                .success(),
            SshAuth::PrivateKey { pem, passphrase } => {
                let key = decode_secret_key(pem, passphrase.as_deref()).map_err(|e| {
                    OmniError::new(ErrorCode::Auth, "SSH 私钥解析失败").with_cause(e.to_string())
                })?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| {
                        OmniError::new(ErrorCode::Ssh, "协商 RSA 哈希失败")
                            .with_cause(e.to_string())
                    })?
                    .flatten();
                session
                    .authenticate_publickey(
                        &config.user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| {
                        OmniError::new(ErrorCode::Auth, "SSH 公钥认证失败")
                            .with_cause(e.to_string())
                    })?
                    .success()
            }
        };

        if !auth_ok {
            return Err(OmniError::new(ErrorCode::Auth, "SSH 认证被拒绝"));
        }

        Ok(Self {
            session,
            shell_tx: None,
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
        let mut channel = self.session.channel_open_session().await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开 SSH exec 通道失败").with_cause(e.to_string())
        })?;
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

    /// 在独立 exec channel 上以流式方式运行命令，stdout/stderr 实时写入 `tx`。
    /// 返回 [`SshStreamHandle`]，调用方 `stop()` 即可中止远端命令。
    /// 与 `exec_capture` 互不影响：远端 SSH 上可同时存在多个 exec channel。
    pub async fn exec_stream(
        &self,
        command: &str,
        tx: mpsc::UnboundedSender<StreamChunk>,
    ) -> OmniResult<SshStreamHandle> {
        let mut channel = self.session.channel_open_session().await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开 SSH exec 通道失败").with_cause(e.to_string())
        })?;
        channel.exec(true, command).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "发起 SSH 命令失败").with_cause(e.to_string())
        })?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();

        let task = tokio::spawn(async move {
            run_stream_task(&mut channel, tx, stop_clone).await;
        });

        Ok(SshStreamHandle { stop, _task: Some(task) })
    }

    /// 在独立 exec channel 上以 PTY 模式运行命令，返回 [`SshPtySession`] 用于交互式终端。
    /// 适用于 `docker exec -it <id> /bin/sh` 这类需要 TTY 的场景。
    /// 命令输出以 `StreamChunk` 形式经 `tx` 推送。
    pub async fn exec_pty(
        &self,
        command: &str,
        cols: u16,
        rows: u16,
        tx: mpsc::UnboundedSender<StreamChunk>,
    ) -> OmniResult<SshPtySession> {
        let channel = self.session.channel_open_session().await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开 SSH PTY 通道失败").with_cause(e.to_string())
        })?;
        channel
            .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "请求 PTY 失败").with_cause(e.to_string()))?;
        channel.exec(true, command).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "发起 PTY exec 命令失败").with_cause(e.to_string())
        })?;

        // 复用已打开的 exec channel（而非创建第二个空 channel）。
        let shared: Arc<tokio::sync::Mutex<Channel<russh::client::Msg>>> =
            Arc::new(tokio::sync::Mutex::new(channel));
        let reader_shared = shared.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let task = tokio::spawn(async move {
            let mut guard = reader_shared.lock().await;
            run_stream_task(&mut guard, tx, stop_clone).await;
        });

        Ok(SshPtySession {
            channel: shared,
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

    async fn open_sftp(&self) -> OmniResult<SftpSession> {
        let channel = self.session.channel_open_session().await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "打开 SFTP 通道失败").with_cause(e.to_string())
        })?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "请求 SFTP 子系统失败").with_cause(e.to_string())
        })?;
        SftpSession::new(channel.into_stream()).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "初始化 SFTP 会话失败").with_cause(e.to_string())
        })
    }

    /// 列出远端目录。
    pub async fn sftp_list(&self, path: &str) -> OmniResult<Vec<SftpEntry>> {
        let sftp = self.open_sftp().await?;
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
            entries.push(SftpEntry {
                name: entry.file_name(),
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
            });
        }
        Ok(entries)
    }

    /// 下载远端文件内容。
    pub async fn sftp_download(&self, path: &str) -> OmniResult<Vec<u8>> {
        let sftp = self.open_sftp().await?;
        sftp.read(path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "下载文件失败").with_cause(e.to_string()))
    }

    /// 上传内容到远端文件（覆盖）。
    pub async fn sftp_upload(&self, path: &str, data: &[u8]) -> OmniResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.write(path, data)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "上传文件失败").with_cause(e.to_string()))
    }

    pub async fn sftp_mkdir(&self, path: &str) -> OmniResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.create_dir(path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "创建目录失败").with_cause(e.to_string()))
    }

    pub async fn sftp_remove(&self, path: &str) -> OmniResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.remove_file(path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "删除失败").with_cause(e.to_string()))
    }

    /// 重命名远程文件/目录。
    pub async fn sftp_rename(&self, old_path: &str, new_path: &str) -> OmniResult<()> {
        let sftp = self.open_sftp().await?;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Ssh, "重命名失败").with_cause(e.to_string()))
    }

    /// 修改远程文件权限（通过 exec chmod）。
    pub async fn sftp_chmod(&self, path: &str, mode: u32) -> OmniResult<()> {
        let cmd = format!("chmod {:o} {}", mode, path);
        self.exec_capture(&cmd)
            .await?
            .ok_or_err("chmod 失败")?;
        Ok(())
    }

    /// 列出远程进程列表（解析 ps aux 输出）。
    pub async fn process_list(&self) -> OmniResult<Vec<SshProcessInfo>> {
        let output = self
            .exec_command(
                "COLUMNS=2000 ps aux --no-headers 2>/dev/null || COLUMNS=2000 ps aux | tail -n +2",
            )
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Ssh, "获取进程列表失败").with_cause(e.to_string())
            })?;
        let mut processes = Vec::new();
        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let fields: Vec<&str> = line.splitn(11, char::is_whitespace).collect();
            if fields.len() < 11 {
                continue;
            }
            let command = fields[10].to_string();
            if command.is_empty() {
                continue;
            }
            let Ok(pid) = fields[1].parse::<u32>() else {
                continue;
            };
            processes.push(SshProcessInfo {
                user: fields[0].to_string(),
                pid,
                cpu: fields[2].parse().unwrap_or(0.0),
                mem: fields[3].parse().unwrap_or(0.0),
                vsz: fields[4].parse().unwrap_or(0),
                rss: fields[5].parse().unwrap_or(0),
                stat: fields[7].to_string(),
                start: fields[8].to_string(),
                time: fields[9].to_string(),
                command,
            });
        }
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
}
