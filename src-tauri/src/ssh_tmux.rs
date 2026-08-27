//! 远程终端的 tmux control mode 复用层。
//!
//! 同一台主机（`user@host:port`）的全部远程 Tab 共用一条 SSH 连接与一个 tmux
//! 会话，每个 Tab 是其中一个 window。前端与事件契约完全不变：pane 输出仍以
//! `{ session_id, data: base64 }` 经 `terminal-output` 送出，`session_id` 依旧是
//! `ssh-{n}`。
//!
//! 远端不满足条件时一律降级为原有的直连 shell，降级不应产生任何用户可见错误。

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{OmniError, OmniResult};
use omnipanel_ssh::tmux::{
    ControllerEvent, PaneId, TmuxController, TmuxSink, commands as tmux_commands,
};
use omnipanel_ssh::{SshConfig, SshSession};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::output_buffer::{self, OutputBuffers};

/// 最后一个 Tab 关闭后，control 连接的保活时长。
///
/// 保活是为了让「关掉再开」不必重新握手认证；超时后回收以免长期占用远端资源。
/// 注意回收的只是本地连接，远端 tmux 会话及其中的进程不受影响。
const IDLE_REAP_DELAY: Duration = Duration::from_secs(300);

/// 「不支持 tmux」标记的 TTL：与 `ssh_capabilities` 的能力缓存对齐。
///
/// 用户可能在装好 tmux 后立刻开终端，无 TTL 会导致本进程内永久降级。
/// 过期后重新探测，既能避免频繁重试，又能让安装/升级后自动恢复。
const UNSUPPORTED_TTL: Duration = Duration::from_secs(300);

/// 主机身份：同一 `user@host:port` 复用同一条 control 连接与 tmux 会话。
pub fn host_identity(config: &SshConfig) -> String {
    format!("{}@{}:{}", config.user, config.host, config.port)
}

/// 终端传输模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalMode {
    /// 经 tmux control mode，连接复用且会话可持久。
    Tmux,
    /// 一 Tab 一条 SSH 连接的直连 shell。
    Direct,
}

/// 单个远程终端的传输信息，供前端展示模式标识。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalInfo {
    pub mode: TerminalMode,
    pub host: String,
    pub tmux_version: Option<String>,
    pub tmux_session: Option<String>,
    /// tmux pane id（如 `%5`），用于关 Tab 后重连恢复原 window。
    pub tmux_pane_id: Option<u32>,
    /// 降级到直连的原因，`tmux` 模式下为 `None`。
    pub fallback_reason: Option<String>,
}

/// 一台主机的 control 连接。
struct TmuxHost {
    /// 承载 control channel 的连接。必须持有，否则连接被 drop 后通道即断。
    session: Arc<SshSession>,
    controller: Arc<TmuxController>,
    version: String,
    session_name: String,
}

impl TmuxHost {
    fn is_alive(&self) -> bool {
        !self.controller.is_closed() && !self.session.is_closed()
    }
}

struct SessionBinding {
    host_key: String,
    controller: Arc<TmuxController>,
    version: String,
    session_name: String,
    /// 该 Tab 对应的 pane id，用于前端持久化后重连恢复原 window。
    pane_id: Option<u32>,
    /// 保留连接配置，供「切直连」逃生阀原地重建会话而无需前端重新发起连接。
    config: SshConfig,
}

/// 直连会话的记录，仅用于前端展示模式与降级原因。
struct DirectRecord {
    host: String,
    reason: Option<String>,
}

/// 「不支持 tmux」的缓存条目：降级原因 + 标记时刻，TTL 过期后允许重新探测。
struct UnsupportedEntry {
    reason: String,
    marked_at: Instant,
}

/// attach 结果。接入成功后的版本与会话名经 `info` 查询，无需在此回传。
pub enum AttachOutcome {
    Attached,
    /// 远端不支持，调用方应走直连路径。
    Unsupported(String),
}

/// 单个 tmux 会话当前被 OmniPanel 的多少个 Tab 关联。
///
/// 关联计数来自后端 `sessions` 表（跨所有窗口共享），不依赖前端 per-window 的
/// terminalStore——远端会话治理视图所在窗口未必持有开 Tab 的窗口的 store 状态。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTabStat {
    pub session_name: String,
    pub tab_count: usize,
}

/// 按主机复用 tmux 控制器。
#[derive(Default)]
pub struct TmuxManager {
    hosts: Mutex<HashMap<String, Arc<TmuxHost>>>,
    /// 每主机建连串行锁，避免同时开多个 Tab 时重复建连。
    connect_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// 后端会话 id（`ssh-{n}`）→ 绑定信息。
    sessions: Mutex<HashMap<String, SessionBinding>>,
    /// 走直连的会话，供前端查询模式与降级原因。
    direct: Mutex<HashMap<String, DirectRecord>>,
    /// 已知不可用的主机及原因，避免每次开 Tab 都重复探测。
    /// 条目带 TTL，过期后重新探测，让用户安装/升级 tmux 后能自动恢复。
    unsupported: Mutex<HashMap<String, UnsupportedEntry>>,
}

impl TmuxManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 把一个远程终端接入 tmux；返回 [`AttachOutcome::Unsupported`] 表示应降级直连。
    ///
    /// - `session_name_override` 为 `Some` 时 attach 到指定会话名（用于从远端会话列表
    ///   进入某个具体会话）；为 `None` 时用默认的 `omnipanel-<host>` 会话名。
    /// - `pane_id_override` 为 `Some` 时尝试 attach 回该 pane 对应的原 window（关 Tab
    ///   保留进程后重连恢复），匹配不到则降级为新建 window。
    pub async fn attach(
        self: &Arc<Self>,
        app: &AppHandle,
        buffers: &OutputBuffers,
        config: &SshConfig,
        session_id: &str,
        cols: u16,
        rows: u16,
        session_name_override: Option<&str>,
        pane_id_override: Option<u32>,
    ) -> OmniResult<AttachOutcome> {
        let host_key = host_identity(config);
        // 先归一化 session_name：None 时用默认的 omnipanel-<host>。
        // cache_key 统一基于 session_name，确保默认会话（sshConnectConnection 路径）
        // 与显式传入同名会话（sshTmuxAttachSession 重连路径）复用同一条 control 连接。
        // 否则两条路径的 cache_key 不同会建立第二条 control 连接，new-session -D 把
        // 已有 client 顶下线，表现为「同主机多组 Tab 互踢、不可同时连接」。
        let session_name = match session_name_override {
            Some(name) => tmux_commands::sanitize_session_name(name),
            None => tmux_commands::session_name_for_workspace(&host_key),
        };
        let cache_key = format!("{host_key}:{session_name}");

        // 过期的 unsupported 条目视为不存在，让安装/升级 tmux 后能自动恢复
        if let Some(reason) = self.unsupported_reason(&cache_key).await {
            return Ok(AttachOutcome::Unsupported(reason));
        }

        let lock = self.connect_lock(&cache_key).await;
        let _guard = lock.lock().await;

        let used_cached = self.live_host(&cache_key).await.is_some();
        match self
            .attach_with_resolved_host(
                app,
                buffers,
                config,
                session_id,
                cols,
                rows,
                &cache_key,
                &session_name,
                pane_id_override,
            )
            .await
        {
            Ok(outcome) => Ok(outcome),
            Err(err) if used_cached => {
                // 主机宕机/重启后半开 TCP 仍可能通过 is_alive；丢弃僵死 control 后重建一次。
                tracing::warn!(
                    target: "tmux",
                    "复用 tmux control 失败，丢弃缓存并重建: {cache_key}: {}",
                    err.user_message()
                );
                self.drop_host(&cache_key).await;
                self.attach_with_resolved_host(
                    app,
                    buffers,
                    config,
                    session_id,
                    cols,
                    rows,
                    &cache_key,
                    &session_name,
                    pane_id_override,
                )
                .await
            }
            Err(err) => Err(err),
        }
    }

    async fn drop_host(&self, cache_key: &str) {
        if let Some(host) = self.hosts.lock().await.remove(cache_key) {
            host.controller
                .mark_disconnected("丢弃僵死 tmux control 连接");
            host.session.disconnect().await;
        }
    }

    async fn attach_with_resolved_host(
        self: &Arc<Self>,
        app: &AppHandle,
        buffers: &OutputBuffers,
        config: &SshConfig,
        session_id: &str,
        cols: u16,
        rows: u16,
        cache_key: &str,
        session_name: &str,
        pane_id_override: Option<u32>,
    ) -> OmniResult<AttachOutcome> {
        let host = match self.live_host(cache_key).await {
            Some(host) => host,
            None => match self
                .spawn_host(app, buffers, config, cache_key, cols, rows, session_name)
                .await?
            {
                Some(host) => host,
                None => {
                    let reason = self
                        .unsupported_reason(cache_key)
                        .await
                        .unwrap_or_else(|| "远端 tmux 不可用".to_string());
                    return Ok(AttachOutcome::Unsupported(reason));
                }
            },
        };

        host.controller.ensure_utf8_locale().await;

        // 优先 attach 回原 window（关 Tab 保留进程后重连），匹配不到则新建。
        // create_window 返回的 PaneEntry 必须回填，否则前端无法在关 Tab 后按 pane 恢复。
        let pane_id = if let Some(pid) = pane_id_override {
            match host
                .controller
                .attach_to_existing_pane(session_id, &host.session_name, PaneId(pid))
                .await?
            {
                Some(entry) => Some(entry.pane.0),
                None => {
                    // 原 window 已不存在（远端会话被 kill），降级新建
                    let entry = host
                        .controller
                        .create_window(session_id, cols, rows, None)
                        .await?;
                    Some(entry.pane.0)
                }
            }
        } else {
            let entry = host
                .controller
                .create_window(session_id, cols, rows, None)
                .await?;
            Some(entry.pane.0)
        };

        self.direct.lock().await.remove(session_id);
        self.sessions.lock().await.insert(
            session_id.to_string(),
            SessionBinding {
                host_key: cache_key.to_string(),
                controller: host.controller.clone(),
                version: host.version.clone(),
                session_name: host.session_name.clone(),
                pane_id,
                config: config.clone(),
            },
        );

        Ok(AttachOutcome::Attached)
    }

    async fn connect_lock(&self, host_key: &str) -> Arc<Mutex<()>> {
        self.connect_locks
            .lock()
            .await
            .entry(host_key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// 取存活的 host，顺带清理已失效的条目。
    async fn live_host(&self, host_key: &str) -> Option<Arc<TmuxHost>> {
        let mut hosts = self.hosts.lock().await;
        match hosts.get(host_key) {
            Some(host) if host.is_alive() => Some(host.clone()),
            Some(_) => {
                hosts.remove(host_key);
                None
            }
            None => None,
        }
    }

    /// 取未过期的 unsupported 原因；过期条目会被清除并返回 `None`。
    async fn unsupported_reason(&self, host_key: &str) -> Option<String> {
        let mut map = self.unsupported.lock().await;
        let expired = map
            .get(host_key)
            .map(|e| e.marked_at.elapsed() >= UNSUPPORTED_TTL)
            .unwrap_or(false);
        if expired {
            map.remove(host_key);
            return None;
        }
        map.get(host_key).map(|e| e.reason.clone())
    }

    /// 清除全部 unsupported 缓存，让下次开 Tab 重新探测。
    ///
    /// 在用户于能力治理 Tab 刷新探测或安装/升级 tmux 后调用，避免本进程内
    /// 残留的旧标记导致新 Tab 仍降级直连。全清代价低（低频操作），且重新
    /// 探测本身有 connect_lock 串行保护。
    pub async fn invalidate_all(&self) {
        self.unsupported.lock().await.clear();
    }

    /// 建立新的 control 连接。返回 `Ok(None)` 表示远端不支持（已记入缓存）。
    ///
    /// `session_name` 由调用方在 `attach` 中归一化好传入（None 已替换为默认会话名），
    /// 这里直接用于 `new-session -s <name>`，不再二次推导。
    async fn spawn_host(
        self: &Arc<Self>,
        app: &AppHandle,
        buffers: &OutputBuffers,
        config: &SshConfig,
        cache_key: &str,
        cols: u16,
        rows: u16,
        session_name: &str,
    ) -> OmniResult<Option<Arc<TmuxHost>>> {
        let session = Arc::new(SshSession::connect_no_shell(config.clone()).await?);

        let sink = self.build_sink(app, buffers);
        let control = match session
            .open_tmux_control(&session_name, cols, rows, sink)
            .await
        {
            Ok(control) => control,
            Err(err) => {
                // 探测失败或版本过低：记入缓存（带 TTL）后降级，不向用户抛错
                tracing::info!(
                    target: "tmux",
                    "主机 {cache_key} 不支持 tmux control mode，降级直连: {err}"
                );
                self.unsupported.lock().await.insert(
                    cache_key.to_string(),
                    UnsupportedEntry {
                        reason: err.user_message(),
                        marked_at: Instant::now(),
                    },
                );
                return Ok(None);
            }
        };

        let host = Arc::new(TmuxHost {
            session,
            controller: control.controller,
            version: control.version.to_string(),
            session_name: control.session_name,
        });
        self.hosts
            .lock()
            .await
            .insert(cache_key.to_string(), host.clone());
        Ok(Some(host))
    }

    /// 构造 control 事件回调：沿用既有 `terminal-output` / `terminal-event` 契约。
    fn build_sink(self: &Arc<Self>, app: &AppHandle, buffers: &OutputBuffers) -> TmuxSink {
        let app = app.clone();
        let buffers = buffers.clone();
        // 弱引用：host 经 sink 间接持有 manager，强引用会形成环
        let manager: Weak<Self> = Arc::downgrade(self);
        Arc::new(move |event: ControllerEvent| match event {
            ControllerEvent::Output { session_id, data } => {
                output_buffer::append(&buffers, &session_id, &data);
                let _ = app.emit(
                    "terminal-output",
                    serde_json::json!({
                        "session_id": session_id,
                        "data": STANDARD.encode(&data),
                    }),
                );
            }
            ControllerEvent::SessionClosed { session_id } => {
                let _ = app.emit(
                    "terminal-event",
                    serde_json::json!({ "session_id": session_id, "event": "exited" }),
                );
                if let Some(manager) = manager.upgrade() {
                    tokio::spawn(async move {
                        manager.forget_session(&session_id).await;
                    });
                }
            }
            // 每个会话已由 SessionClosed 单独通知，这里无需再广播
            ControllerEvent::Terminated { reason } => {
                tracing::info!(target: "tmux", "control 连接终止: {reason:?}");
            }
        })
    }

    async fn binding(&self, session_id: &str) -> Option<(String, Arc<TmuxController>)> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|b| (b.host_key.clone(), b.controller.clone()))
    }

    /// 会话的传输信息，未知会话返回 `None`。
    pub async fn info(&self, session_id: &str) -> Option<SshTerminalInfo> {
        if let Some(b) = self.sessions.lock().await.get(session_id) {
            return Some(SshTerminalInfo {
                mode: TerminalMode::Tmux,
                host: b.host_key.clone(),
                tmux_version: Some(b.version.clone()),
                tmux_session: Some(b.session_name.clone()),
                tmux_pane_id: b.pane_id,
                fallback_reason: None,
            });
        }
        self.direct
            .lock()
            .await
            .get(session_id)
            .map(|d| SshTerminalInfo {
                mode: TerminalMode::Direct,
                host: d.host.clone(),
                tmux_version: None,
                tmux_session: None,
                tmux_pane_id: None,
                fallback_reason: d.reason.clone(),
            })
    }

    /// 统计指定主机上每个 tmux 会话当前被几个 Tab 关联。
    ///
    /// 遍历 `sessions` 表，筛选 `host_key` 匹配的条目（`host_key` 形如
    /// `user@host:port` 或 `user@host:port:session_name`），按 `session_name`
    /// 分组计数。直连会话不计入（它们没有 tmux 会话名）。
    pub async fn tab_stats_for_host(&self, host_key: &str) -> Vec<TmuxTabStat> {
        let sessions = self.sessions.lock().await;
        let mut map: HashMap<String, usize> = HashMap::new();
        for binding in sessions.values() {
            // host_key 可能是 "user@host:port"（默认会话）或 "user@host:port:session"（指定会话），
            // 都以原始 host_identity 开头，因此用前缀匹配
            if binding.host_key == host_key || binding.host_key.starts_with(&format!("{host_key}:"))
            {
                *map.entry(binding.session_name.clone()).or_insert(0) += 1;
            }
        }
        map.into_iter()
            .map(|(session_name, tab_count)| TmuxTabStat {
                session_name,
                tab_count,
            })
            .collect()
    }

    /// 登记一个直连会话及其降级原因。
    pub async fn record_direct(&self, session_id: &str, host: String, reason: Option<String>) {
        self.direct
            .lock()
            .await
            .insert(session_id.to_string(), DirectRecord { host, reason });
    }

    /// 会话结束时清理直连记录。
    pub async fn forget_direct(&self, session_id: &str) {
        self.direct.lock().await.remove(session_id);
    }

    /// 取出会话的连接配置，供逃生阀原地重建为直连。
    pub async fn config_of(&self, session_id: &str) -> Option<SshConfig> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|b| b.config.clone())
    }

    /// 写入按键。返回 `None` 表示该会话不归 tmux 管，调用方走原路径。
    pub async fn write(&self, session_id: &str, data: &[u8]) -> Option<OmniResult<()>> {
        let (_, controller) = self.binding(session_id).await?;
        Some(controller.write(session_id, data))
    }

    /// 调整尺寸。返回 `None` 表示该会话不归 tmux 管。
    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Option<OmniResult<()>> {
        let (_, controller) = self.binding(session_id).await?;
        Some(controller.resize(session_id, cols, rows))
    }

    /// 抓取 pane 内容用于恢复屏幕。
    pub async fn capture_pane(&self, session_id: &str, history_lines: u32) -> OmniResult<Vec<u8>> {
        let (_, controller) = self
            .binding(session_id)
            .await
            .ok_or_else(|| OmniError::not_found(format!("会话 {session_id} 不在 tmux 模式")))?;
        controller.capture_pane(session_id, history_lines).await
    }

    /// 关闭一个终端 Tab：从本地映射摘除，但**不 kill 远端 window**。
    ///
    /// 下载等耗时命令继续在远端跑；重新打开同一会话时用持久化的 pane_id
    /// 走 `attach_to_existing_pane` 恢复原 window 的屏幕与进程。
    /// 真正要杀掉远端 window 需在远端会话治理视图点「终止」。
    pub async fn close(self: &Arc<Self>, session_id: &str) -> bool {
        let Some((host_key, controller)) = self.binding(session_id).await else {
            return false;
        };
        if let Err(err) = controller.detach_window(session_id) {
            tracing::warn!(target: "tmux", "摘除 window 映射失败: {err}");
        }
        self.forget_session(session_id).await;
        self.schedule_idle_reap(host_key);
        true
    }

    /// 把会话从 tmux 解绑但**不**关闭远端 window（逃生阀：切直连时保留原会话）。
    pub async fn detach(self: &Arc<Self>, session_id: &str) -> bool {
        let Some((host_key, _)) = self.binding(session_id).await else {
            return false;
        };
        self.forget_session(session_id).await;
        self.schedule_idle_reap(host_key);
        true
    }

    async fn forget_session(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
    }

    /// 主机上最后一个 Tab 关闭后延迟回收 control 连接。
    fn schedule_idle_reap(self: &Arc<Self>, host_key: String) {
        let manager = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(IDLE_REAP_DELAY).await;
            let still_idle = {
                let hosts = manager.hosts.lock().await;
                match hosts.get(&host_key) {
                    Some(host) => host.controller.session_count() == 0,
                    None => false,
                }
            };
            if still_idle {
                // 只断开本地连接；远端 tmux 会话与其中的进程继续存活
                if let Some(host) = manager.hosts.lock().await.remove(&host_key) {
                    host.session.disconnect().await;
                    tracing::info!(target: "tmux", "回收空闲 control 连接: {host_key}");
                }
                manager.connect_locks.lock().await.remove(&host_key);
            }
        });
    }
}
