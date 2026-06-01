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
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key, ssh_key};
use russh::{ChannelMsg, Disconnect};
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
pub struct SshSession {
    session: client::Handle<Client>,
    shell_tx: mpsc::UnboundedSender<ShellMsg>,
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

        Ok(Self { session, shell_tx })
    }

    /// 写入 shell 输入。
    pub fn write(&self, data: &[u8]) -> OmniResult<()> {
        self.shell_tx
            .send(ShellMsg::Data(data.to_vec()))
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 会话已关闭"))
    }

    /// 调整远端 PTY 窗口大小。
    pub fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        self.shell_tx
            .send(ShellMsg::Resize(cols, rows))
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "SSH 会话已关闭"))
    }

    /// Execute a single command on the existing SSH session (separate channel).
    /// Returns stdout as a UTF-8 string.
    pub async fn exec_command(&self, command: &str) -> OmniResult<String> {
        let mut channel = self
            .session
            .channel_open_session()
            .await
            .map_err(|e| OmniError::ssh("打开命令执行通道失败").with_cause(e.to_string()))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| OmniError::ssh("远程命令执行失败").with_cause(e.to_string()))?;

        let mut output = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { ref data }) => {
                    output.extend_from_slice(data);
                }
                Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                    output.extend_from_slice(data);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    if exit_status != 0 {
                        let stderr = String::from_utf8_lossy(&output);
                        return Err(OmniError::ssh("远程命令返回非零退出码")
                            .with_cause(format!("exit={exit_status} stderr={stderr}")));
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }

        Ok(String::from_utf8_lossy(&output).trim().to_string())
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
            OmniError::new(ErrorCode::Ssh, "读取目录失败").with_cause(e.to_string())
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
