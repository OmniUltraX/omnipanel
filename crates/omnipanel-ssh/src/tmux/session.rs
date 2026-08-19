//! 把 tmux control mode 接到 SSH channel 上。
//!
//! control 连接独占一个 SSH channel：出站是 tmux 命令行，入站是 control 协议行。
//! 该 channel 与既有的交互 shell / exec / SFTP channel 并存，互不影响。

use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use russh::ChannelMsg;
use tokio::sync::mpsc;

use crate::pty_utf8::ssh_utf8_pty_modes;
use super::commands;
use super::controller::{ControllerEvent, TmuxController};
use super::line::LineAssembler;
use super::probe::{self, TmuxCapability};
use crate::{open_session_channel_retry, SshSession, CHANNEL_OPEN_ATTEMPTS};

/// control 事件回调。`src-tauri` 注入「emit 到前端」的实现。
pub type TmuxSink = Arc<dyn Fn(ControllerEvent) + Send + Sync>;

/// 已建立的 tmux control 连接。
pub struct TmuxControl {
    /// 命令与输出的操作入口。
    pub controller: Arc<TmuxController>,
    /// 远端 tmux 版本，用于前端展示与问题定位。
    pub version: probe::TmuxVersion,
    /// 实际 attach 的会话名（已做字符净化）。
    pub session_name: String,
}

impl SshSession {
    /// 探测远端 tmux 能力。任何失败都归为 [`TmuxCapability::Unavailable`]，
    /// 由调用方降级为直连 shell——探测本身绝不应让连接流程失败。
    pub async fn probe_tmux(&self) -> TmuxCapability {
        match self.exec_capture(&commands::version_probe_command()).await {
            Ok(out) => probe::evaluate(Some(out.exit_code), &out.stdout, &out.stderr),
            Err(err) => TmuxCapability::Unavailable(err.user_message()),
        }
    }

    /// 在独立 channel 上启动 tmux control mode，attach 到已有会话或新建一个。
    ///
    /// `cols` / `rows` 只用于 control 客户端自身的初始尺寸；各 Tab 的实际尺寸
    /// 由 `TmuxController::create_window` 逐 window 单独设置。
    pub async fn open_tmux_control(
        &self,
        session_name: &str,
        cols: u16,
        rows: u16,
        sink: TmuxSink,
    ) -> OmniResult<TmuxControl> {
        let capability = self.probe_tmux().await;
        let version = match capability {
            TmuxCapability::Supported(v) => v,
            TmuxCapability::TooOld(v) => {
                return Err(OmniError::new(
                    ErrorCode::Ssh,
                    format!("远端 tmux {v} 版本过低，需要 {} 及以上", probe::MIN_SUPPORTED),
                ));
            }
            TmuxCapability::Unavailable(reason) => {
                return Err(OmniError::new(ErrorCode::Ssh, "远端 tmux 不可用").with_cause(reason));
            }
        };

        let session_name = commands::sanitize_session_name(session_name);
        let mut channel =
            open_session_channel_retry(&self.session, CHANNEL_OPEN_ATTEMPTS, &self.closed)
                .await
                .map_err(|e| e.or_ssh_context("打开 tmux control 通道失败"))?;

        // tmux 客户端要求有控制终端，没有 PTY 会直接以 "open terminal failed" 退出
        channel
            .request_pty(
                false,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &ssh_utf8_pty_modes(),
            )
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Ssh, "为 tmux control 通道请求 PTY 失败")
                    .with_cause(e.to_string())
            })?;

        let launch = commands::control_mode_command(&session_name, cols, rows);
        channel.exec(true, launch.as_bytes()).await.map_err(|e| {
            OmniError::new(ErrorCode::Ssh, "启动 tmux control mode 失败").with_cause(e.to_string())
        })?;

        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ControllerEvent>();
        let controller = Arc::new(TmuxController::new(cmd_tx, event_tx));

        // 事件转发任务：控制器与 sink 解耦，便于单测直接消费 mpsc
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                sink(event);
            }
        });

        let io_controller = controller.clone();
        let closed_flag = self.closed.clone();
        tokio::spawn(async move {
            let mut assembler = LineAssembler::new();
            let reason = loop {
                tokio::select! {
                    outgoing = cmd_rx.recv() => {
                        match outgoing {
                            Some(bytes) => {
                                if channel.data(&bytes[..]).await.is_err() {
                                    break "tmux control 通道写入失败";
                                }
                            }
                            // 控制器已释放，正常收尾
                            None => break "tmux control 连接已关闭",
                        }
                    }
                    incoming = channel.wait() => {
                        match incoming {
                            Some(ChannelMsg::Data { ref data }) => {
                                assembler.push(data, |line| io_controller.dispatch_line(line));
                            }
                            // control mode 下 stderr 只会是 tmux 自身的告警，按行喂入同样安全
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                assembler.push(data, |line| io_controller.dispatch_line(line));
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                break "tmux control 通道已关闭";
                            }
                            _ => {}
                        }
                    }
                }
            };
            // 通道断开意味着底层 SSH 连接不可用，同步标记以便连接池重建
            closed_flag.store(true, std::sync::atomic::Ordering::Relaxed);
            io_controller.mark_disconnected(reason);
        });

        // 限制 detached 会话的历史缓冲，避免远端内存随时间不受控增长
        controller
            .set_history_limit(commands::DEFAULT_HISTORY_LIMIT)
            .await?;

        Ok(TmuxControl {
            controller,
            version,
            session_name,
        })
    }
}
