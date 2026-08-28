//! tmux control mode 控制器：命令队列、输出路由与会话操作。
//!
//! 控制器本身不做任何 I/O，入站行由外部循环喂给 [`TmuxController::dispatch_line`]，
//! 出站命令经 `cmd_tx` 交给外部循环写入 control channel。这样协议状态机可以脱离
//! SSH 完整测试。

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use tokio::sync::{mpsc, oneshot};

use super::commands::{self, TmuxSessionInfo, parse_session_line};
use super::parser::{ControlEvent, PaneId, WindowId, parse_line};
use super::registry::{PaneEntry, PaneRegistry};

/// 单条 tmux 命令的等待上限。控制连接正常时响应在毫秒级，超时即视为链路异常。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// 命令响应体：`%begin` 与 `%end` 之间的原始行。
pub type CommandResponse = Vec<Vec<u8>>;

/// 控制器向上层推送的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControllerEvent {
    /// 某个远程会话产生了输出。
    Output { session_id: String, data: Vec<u8> },
    /// 会话对应的 window 已关闭（远端 shell 退出或被 kill）。
    SessionClosed { session_id: String },
    /// control 连接终止，全部会话失效。
    Terminated { reason: Option<String> },
}

/// 命令响应队列：tmux 对每条命令按 FIFO 回一组 `%begin` … `%end`/`%error`。
#[derive(Default)]
struct CommandQueue {
    pending: VecDeque<oneshot::Sender<OmniResult<CommandResponse>>>,
    active: Option<(
        oneshot::Sender<OmniResult<CommandResponse>>,
        CommandResponse,
    )>,
}

impl CommandQueue {
    fn enqueue(&mut self, tx: oneshot::Sender<OmniResult<CommandResponse>>) {
        self.pending.push_back(tx);
    }

    /// 命令未能写出时撤回占位，否则队列会比实际发出的命令多一格，
    /// 导致此后每条响应都错配到前一条命令。
    fn cancel_last(&mut self) {
        self.pending.pop_back();
    }

    fn on_begin(&mut self) {
        // 上一条若因协议异常未收到 %end，这里顺带丢弃，保证不串位
        if let Some((tx, _)) = self.active.take() {
            let _ = tx.send(Err(OmniError::new(
                ErrorCode::Ssh,
                "tmux 命令响应被新的响应打断",
            )));
        }
        if let Some(tx) = self.pending.pop_front() {
            self.active = Some((tx, Vec::new()));
        }
    }

    fn on_raw(&mut self, line: Vec<u8>) {
        if let Some((_, buf)) = self.active.as_mut() {
            buf.push(line);
        }
    }

    /// 结束当前响应。返回值为「无人接收的错误文本」，供调用方记日志——
    /// 写入/resize 这类命令是 fire-and-forget，出错时没有等待者会看到它。
    fn on_end(&mut self, is_error: bool) -> Option<String> {
        let (tx, lines) = self.active.take()?;
        if !is_error {
            let _ = tx.send(Ok(lines));
            return None;
        }
        let detail = lines
            .iter()
            .map(|l| String::from_utf8_lossy(l).into_owned())
            .collect::<Vec<_>>()
            .join("; ");
        let err = OmniError::new(ErrorCode::Ssh, "tmux 命令执行失败").with_cause(detail.clone());
        match tx.send(Err(err)) {
            Ok(()) => None,
            Err(_) => Some(detail),
        }
    }

    /// 连接断开时唤醒全部等待者。
    fn fail_all(&mut self, reason: &str) {
        if let Some((tx, _)) = self.active.take() {
            let _ = tx.send(Err(OmniError::new(ErrorCode::Ssh, reason.to_string())));
        }
        while let Some(tx) = self.pending.pop_front() {
            let _ = tx.send(Err(OmniError::new(ErrorCode::Ssh, reason.to_string())));
        }
    }
}

#[derive(Default)]
struct ControllerState {
    registry: PaneRegistry,
    queue: CommandQueue,
    /// 新建 window 已带 LC_CTYPE，不必再往 pane 里打 bind。
    utf8_ready_panes: HashSet<u32>,
}

/// tmux control mode 控制器。
pub struct TmuxController {
    state: Mutex<ControllerState>,
    cmd_tx: mpsc::UnboundedSender<Vec<u8>>,
    event_tx: mpsc::UnboundedSender<ControllerEvent>,
    closed: AtomicBool,
}

impl TmuxController {
    pub fn new(
        cmd_tx: mpsc::UnboundedSender<Vec<u8>>,
        event_tx: mpsc::UnboundedSender<ControllerEvent>,
    ) -> Self {
        Self {
            state: Mutex::new(ControllerState::default()),
            cmd_tx,
            event_tx,
            closed: AtomicBool::new(false),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ControllerState> {
        // 持锁期间不 await，中毒只可能来自测试断言 panic，直接取回内部值即可
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 当前登记的会话数，用于空闲回收判断。
    pub fn session_count(&self) -> usize {
        self.state().registry.len()
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.state().registry.contains(session_id)
    }

    /// 处理一行入站数据。调用方负责按 `\n` 切行并剥离行尾 `\r`。
    pub fn dispatch_line(&self, line: &[u8]) {
        match parse_line(line) {
            ControlEvent::Output { pane, data } => self.route_output(pane, data),
            ControlEvent::ExtendedOutput { pane, data, .. } => self.route_output(pane, data),
            ControlEvent::Begin(_) => self.state().queue.on_begin(),
            ControlEvent::End(_) => {
                let orphan = self.state().queue.on_end(false);
                debug_assert!(orphan.is_none());
            }
            ControlEvent::Error(_) => {
                if let Some(detail) = self.state().queue.on_end(true) {
                    tracing::warn!(target: "tmux", "tmux 命令失败且无等待者: {detail}");
                }
            }
            ControlEvent::Raw(line) => self.state().queue.on_raw(line),
            ControlEvent::WindowClose { window } => self.close_window_mapping(window),
            ControlEvent::Exit { reason } => self.terminate(reason),
            // 其余通知（layout-change、session-changed 等）当前不影响状态机
            _ => {}
        }
    }

    fn route_output(&self, pane: PaneId, data: Vec<u8>) {
        let session_id = {
            let state = self.state();
            state.registry.session_of_pane(pane).map(str::to_string)
        };
        // 尚未登记或已关闭的 pane：丢弃而非报错，避免重连窗口期噪声
        if let Some(session_id) = session_id {
            let _ = self
                .event_tx
                .send(ControllerEvent::Output { session_id, data });
        }
    }

    fn close_window_mapping(&self, window: WindowId) {
        let removed = self.state().registry.remove_window(window);
        if let Some(entry) = removed {
            let _ = self.event_tx.send(ControllerEvent::SessionClosed {
                session_id: entry.session_id,
            });
        }
    }

    fn terminate(&self, reason: Option<String>) {
        self.closed.store(true, Ordering::SeqCst);
        let sessions = {
            let mut state = self.state();
            state.queue.fail_all("tmux control 连接已断开");
            let ids = state.registry.session_ids();
            state.registry.clear();
            ids
        };
        for session_id in sessions {
            let _ = self
                .event_tx
                .send(ControllerEvent::SessionClosed { session_id });
        }
        let _ = self.event_tx.send(ControllerEvent::Terminated { reason });
    }

    /// 连接层检测到通道关闭时调用，语义等同收到 `%exit`。
    pub fn mark_disconnected(&self, reason: impl Into<String>) {
        if !self.is_closed() {
            self.terminate(Some(reason.into()));
        }
    }

    fn write_command(&self, cmd: &str) -> OmniResult<()> {
        let mut line = Vec::with_capacity(cmd.len() + 1);
        line.extend_from_slice(cmd.as_bytes());
        line.push(b'\n');
        self.cmd_tx
            .send(line)
            .map_err(|_| OmniError::new(ErrorCode::Ssh, "tmux control 连接已关闭"))
    }

    /// 发送命令并等待响应。
    pub async fn run_command(&self, cmd: &str) -> OmniResult<CommandResponse> {
        if self.is_closed() {
            return Err(OmniError::new(ErrorCode::Ssh, "tmux control 连接已断开"));
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state();
            state.queue.enqueue(tx);
        }
        // 必须先入队再发命令，否则响应可能先于 sender 入队而错配
        if let Err(err) = self.write_command(cmd) {
            self.state().queue.cancel_last();
            return Err(err);
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(OmniError::new(ErrorCode::Ssh, "tmux 命令响应通道已关闭")),
            Err(_) => {
                // 主机宕机/重启后常见半开 TCP：命令写出无响应。必须标记断开并清空队列，
                // 否则僵死 host 仍被 live_host 复用，后续每次重连都卡满超时。
                self.mark_disconnected(format!("tmux 命令超时: {cmd}"));
                Err(OmniError::new(
                    ErrorCode::Timeout,
                    format!("tmux 命令超时: {cmd}"),
                ))
            }
        }
    }

    /// 发送命令但不等待响应，用于按键写入这类延迟敏感路径。
    ///
    /// 仍需入队占位：tmux 对每条命令都会回一组 `%begin`/`%end`，
    /// 少入队一个 sender 会让后续命令的响应整体错位。
    pub fn fire_command(&self, cmd: &str) -> OmniResult<()> {
        if self.is_closed() {
            return Err(OmniError::new(ErrorCode::Ssh, "tmux control 连接已断开"));
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state();
            state.queue.enqueue(tx);
        }
        drop(rx);
        if let Err(err) = self.write_command(cmd) {
            self.state().queue.cancel_last();
            return Err(err);
        }
        Ok(())
    }

    /// 建立一个新的远程终端：新建 window → 逐 window 设手动尺寸 → 调整到目标尺寸。
    pub async fn create_window(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        shell_command: Option<&str>,
    ) -> OmniResult<PaneEntry> {
        let response = self
            .run_command(&commands::new_window(shell_command))
            .await?;
        let (window, pane) = parse_window_pane(&response)?;

        // 顺序不可颠倒：先固定为手动尺寸，再 resize，否则会被自动布局覆盖。
        // 作用域必须是 -w，global 会崩溃 tmux 3.4+ 服务端。
        self.run_command(&commands::set_window_size_manual(window))
            .await?;
        self.run_command(&commands::resize_window(window, cols, rows))
            .await?;

        let mut state = self.state();
        state.registry.register(session_id, window, pane);
        state.utf8_ready_panes.insert(pane.0);
        Ok(PaneEntry {
            session_id: session_id.to_string(),
            window,
            pane,
        })
    }

    /// 重连后把既有 window 重新登记到会话。
    pub fn adopt_window(&self, session_id: &str, window: WindowId, pane: PaneId) {
        self.state().registry.register(session_id, window, pane);
    }

    fn entry_of(&self, session_id: &str) -> OmniResult<PaneEntry> {
        self.state()
            .registry
            .entry(session_id)
            .cloned()
            .ok_or_else(|| OmniError::not_found(format!("tmux 会话映射不存在: {session_id}")))
    }

    /// 关闭一个远程终端 Tab：只 kill 对应 window，远端 session 与其他 Tab 不受影响。
    pub async fn close_window(&self, session_id: &str) -> OmniResult<()> {
        let entry = self.entry_of(session_id)?;
        self.state().registry.unregister(session_id);
        self.run_command(&commands::kill_window(entry.window))
            .await?;
        Ok(())
    }

    /// 从本地映射摘除一个 Tab，但**不 kill 远端 window**。
    ///
    /// 用于「关 Tab 保留进程」场景：下载等耗时命令继续在远端跑，
    /// 重新打开同一会话时可用 `attach_to_existing_pane` 恢复。
    pub fn detach_window(&self, session_id: &str) -> OmniResult<()> {
        self.state().registry.unregister(session_id);
        Ok(())
    }

    /// 重连后按持久化的 pane_id 找回原 window 并重新登记。
    ///
    /// 通过 `list-panes -s` 查询会话内全部 window/pane，匹配 pane_id 即拿到 window_id，
    /// 然后 `adopt_window` 把 session_id 重新关联到原 window。匹配不到（window 已被杀）
    /// 时返回 `None`，调用方应降级为 `create_window`。
    pub async fn attach_to_existing_pane(
        &self,
        session_id: &str,
        session_name: &str,
        pane_id: PaneId,
    ) -> OmniResult<Option<PaneEntry>> {
        let lines = self
            .run_command(&commands::list_windows(session_name))
            .await?;
        for line in lines {
            if let Some((window, pane, _name)) = parse_pane_line(&line) {
                if pane == pane_id {
                    self.adopt_window(session_id, window, pane);
                    // 切到该 window，让 control mode 开始重放屏幕
                    self.fire_command(&commands::select_window(window))?;
                    return Ok(Some(PaneEntry {
                        session_id: session_id.to_string(),
                        window,
                        pane,
                    }));
                }
            }
        }
        Ok(None)
    }

    /// 让后续 window 带上 UTF-8 locale。失败不阻断会话。
    pub async fn ensure_utf8_locale(&self) {
        for cmd in commands::ensure_utf8_env() {
            let _ = self.run_command(&cmd).await;
        }
    }

    /// 写入按键/粘贴内容。
    pub fn write(&self, session_id: &str, data: &[u8]) -> OmniResult<()> {
        let entry = self.entry_of(session_id)?;
        let need_fix = {
            let state = self.state();
            commands::looks_like_cjk_utf8(data) && !state.utf8_ready_panes.contains(&entry.pane.0)
        };
        if need_fix {
            for cmd in commands::bootstrap_readline_utf8(entry.pane) {
                self.fire_command(&cmd)?;
            }
            self.state().utf8_ready_panes.insert(entry.pane.0);
        }
        for cmd in commands::send_keys_batches(entry.pane, data) {
            self.fire_command(&cmd)?;
        }
        Ok(())
    }

    /// 调整单个 Tab 的尺寸，不影响同连接下的其他 Tab。
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> OmniResult<()> {
        let entry = self.entry_of(session_id)?;
        self.fire_command(&commands::resize_window(entry.window, cols, rows))
    }

    /// 抓取 pane 内容用于重开 Tab 时恢复屏幕。
    pub async fn capture_pane(&self, session_id: &str, history_lines: u32) -> OmniResult<Vec<u8>> {
        let entry = self.entry_of(session_id)?;
        let lines = self
            .run_command(&commands::capture_pane(entry.pane, history_lines))
            .await?;
        Ok(lines.join(&b'\n'))
    }

    pub async fn set_history_limit(&self, limit: u32) -> OmniResult<()> {
        self.run_command(&commands::set_history_limit(limit))
            .await?;
        Ok(())
    }

    /// 列出远端全部会话。
    pub async fn list_sessions(&self) -> OmniResult<Vec<TmuxSessionInfo>> {
        let lines = self.run_command(&commands::list_sessions()).await?;
        Ok(lines.iter().filter_map(|l| parse_session_line(l)).collect())
    }

    /// 终止一个远端会话（含其全部 window）。
    pub async fn kill_session(&self, name: &str) -> OmniResult<()> {
        self.run_command(&commands::kill_session(name)).await?;
        Ok(())
    }

    /// 列出会话内的 window/pane，用于重连后重建映射。
    pub async fn list_panes(
        &self,
        session_name: &str,
    ) -> OmniResult<Vec<(WindowId, PaneId, String)>> {
        let lines = self
            .run_command(&commands::list_windows(session_name))
            .await?;
        Ok(lines.iter().filter_map(|l| parse_pane_line(l)).collect())
    }
}

/// 解析 `new-window -P -F "#{window_id} #{pane_id}"` 的回显，如 `@1 %3`。
fn parse_window_pane(response: &[Vec<u8>]) -> OmniResult<(WindowId, PaneId)> {
    let line = response
        .iter()
        .find(|l| l.starts_with(b"@"))
        .ok_or_else(|| OmniError::new(ErrorCode::Ssh, "tmux 未回显新建 window 标识"))?;
    let text = String::from_utf8_lossy(line);
    let mut parts = text.split_whitespace();
    let window = parts
        .next()
        .and_then(|t| t.strip_prefix('@'))
        .and_then(|t| t.parse().ok())
        .map(WindowId);
    let pane = parts
        .next()
        .and_then(|t| t.strip_prefix('%'))
        .and_then(|t| t.parse().ok())
        .map(PaneId);
    match (window, pane) {
        (Some(w), Some(p)) => Ok((w, p)),
        _ => Err(
            OmniError::new(ErrorCode::Ssh, "无法解析 tmux window/pane 标识")
                .with_cause(text.into_owned()),
        ),
    }
}

fn parse_pane_line(line: &[u8]) -> Option<(WindowId, PaneId, String)> {
    let text = String::from_utf8_lossy(line);
    let mut parts = text.split('\t');
    let window = parts.next()?.trim().strip_prefix('@')?.parse().ok()?;
    let pane = parts.next()?.trim().strip_prefix('%')?.parse().ok()?;
    let name = parts.next().unwrap_or("").trim().to_string();
    Some((WindowId(window), PaneId(pane), name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;

    /// 并发驱动「待测命令」与「模拟 tmux 应答」。
    ///
    /// Rust 的 future 是惰性的：若不先 poll 待测命令，它根本不会入队与发出，
    /// 应答就会落在空队列上并最终超时。二者必须并发推进。
    async fn drive<F: Future, R: Future<Output = ()>>(fut: F, replies: R) -> F::Output {
        let (out, ()) = tokio::join!(fut, replies);
        out
    }

    struct Harness {
        controller: TmuxController,
        cmd_rx: mpsc::UnboundedReceiver<Vec<u8>>,
        event_rx: mpsc::UnboundedReceiver<ControllerEvent>,
    }

    impl Harness {
        fn new() -> Self {
            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (event_tx, event_rx) = mpsc::unbounded_channel();
            Self {
                controller: TmuxController::new(cmd_tx, event_tx),
                cmd_rx,
                event_rx,
            }
        }

        fn sent_commands(&mut self) -> Vec<String> {
            let mut out = Vec::new();
            while let Ok(bytes) = self.cmd_rx.try_recv() {
                out.push(String::from_utf8_lossy(&bytes).trim_end().to_string());
            }
            out
        }

        fn events(&mut self) -> Vec<ControllerEvent> {
            let mut out = Vec::new();
            while let Ok(ev) = self.event_rx.try_recv() {
                out.push(ev);
            }
            out
        }

        /// 模拟 tmux 对一条命令的成功应答。
        fn reply_ok(&self, body: &[&str]) {
            self.controller.dispatch_line(b"%begin 1 1 1");
            for line in body {
                self.controller.dispatch_line(line.as_bytes());
            }
            self.controller.dispatch_line(b"%end 1 1 1");
        }

        fn reply_error(&self, message: &str) {
            self.controller.dispatch_line(b"%begin 1 2 1");
            self.controller.dispatch_line(message.as_bytes());
            self.controller.dispatch_line(b"%error 1 2 1");
        }
    }

    #[test]
    fn routes_output_to_registered_session() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(0), PaneId(0));
        h.controller.adopt_window("ssh-2", WindowId(1), PaneId(1));

        h.controller.dispatch_line(b"%output %1 hi\\015\\012");

        assert_eq!(
            h.events(),
            vec![ControllerEvent::Output {
                session_id: "ssh-2".to_string(),
                data: b"hi\r\n".to_vec()
            }]
        );
    }

    #[test]
    fn drops_output_for_unknown_pane() {
        let mut h = Harness::new();
        h.controller.dispatch_line(b"%output %9 orphan");
        assert!(h.events().is_empty(), "未登记的 pane 输出应被丢弃而非报错");
    }

    #[test]
    fn window_close_notifies_and_unregisters() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(4), PaneId(4));
        h.controller.dispatch_line(b"%window-close @4");

        assert_eq!(
            h.events(),
            vec![ControllerEvent::SessionClosed {
                session_id: "ssh-1".to_string()
            }]
        );
        assert!(!h.controller.has_session("ssh-1"));
        // 后续该 pane 的残留输出不再投递
        h.controller.dispatch_line(b"%output %4 late");
        assert!(h.events().is_empty());
    }

    #[test]
    fn exit_terminates_all_sessions() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(0), PaneId(0));
        h.controller.adopt_window("ssh-2", WindowId(1), PaneId(1));

        h.controller
            .dispatch_line(b"%exit server exited unexpectedly");

        let events = h.events();
        assert_eq!(events.len(), 3, "两个会话关闭 + 一次终止通知");
        assert!(events.iter().any(|e| matches!(
            e,
            ControllerEvent::Terminated { reason: Some(r) } if r == "server exited unexpectedly"
        )));
        assert!(h.controller.is_closed());
        assert_eq!(h.controller.session_count(), 0);
    }

    #[tokio::test]
    async fn run_command_returns_response_body() {
        let h = Harness::new();
        let body = drive(h.controller.run_command("list-sessions"), async {
            tokio::task::yield_now().await;
            h.reply_ok(&["line-a", "line-b"]);
        })
        .await
        .unwrap();
        assert_eq!(body, vec![b"line-a".to_vec(), b"line-b".to_vec()]);
    }

    #[tokio::test]
    async fn run_command_surfaces_tmux_error() {
        let h = Harness::new();
        let err = drive(h.controller.run_command("bogus"), async {
            tokio::task::yield_now().await;
            h.reply_error("unknown command: bogus");
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Ssh);
        assert!(err.cause.unwrap().contains("unknown command"));
    }

    #[tokio::test]
    async fn responses_pair_in_fifo_order_under_concurrency() {
        let h = Harness::new();
        let c = &h.controller;
        let (r1, r2, ()) = tokio::join!(c.run_command("first"), c.run_command("second"), async {
            tokio::task::yield_now().await;
            // 两条命令的应答按发出顺序返回
            c.dispatch_line(b"%begin 1 1 1");
            c.dispatch_line(b"resp-1");
            c.dispatch_line(b"%end 1 1 1");
            c.dispatch_line(b"%begin 1 2 1");
            c.dispatch_line(b"resp-2");
            c.dispatch_line(b"%end 1 2 1");
        });
        assert_eq!(r1.unwrap(), vec![b"resp-1".to_vec()]);
        assert_eq!(r2.unwrap(), vec![b"resp-2".to_vec()]);
    }

    #[tokio::test]
    async fn fire_command_keeps_queue_aligned() {
        let h = Harness::new();
        let c = &h.controller;
        // fire-and-forget 也必须占位，否则后续命令会拿到它的响应
        c.fire_command("send-keys -t %0 -H 61").unwrap();

        let body = drive(c.run_command("list-sessions"), async {
            tokio::task::yield_now().await;
            c.dispatch_line(b"%begin 1 1 1"); // 属于 send-keys
            c.dispatch_line(b"%end 1 1 1");
            c.dispatch_line(b"%begin 1 2 1"); // 属于 list-sessions
            c.dispatch_line(b"the-answer");
            c.dispatch_line(b"%end 1 2 1");
        })
        .await
        .unwrap();
        assert_eq!(body, vec![b"the-answer".to_vec()]);
    }

    #[tokio::test]
    async fn disconnect_wakes_pending_commands() {
        let h = Harness::new();
        let err = drive(h.controller.run_command("list-sessions"), async {
            tokio::task::yield_now().await;
            h.controller.mark_disconnected("链路中断");
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Ssh);
        assert!(h.controller.is_closed());
    }

    #[tokio::test]
    async fn commands_fail_fast_after_close() {
        let h = Harness::new();
        h.controller.mark_disconnected("链路中断");
        assert!(h.controller.run_command("anything").await.is_err());
        assert!(h.controller.fire_command("anything").is_err());
    }

    #[tokio::test]
    async fn create_window_sets_manual_size_before_resize() {
        // 多步命令不能靠 yield 次数对齐时序：改为等命令真正发出后再应答
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let c = TmuxController::new(cmd_tx, event_tx);

        let mut cmds: Vec<String> = Vec::new();
        let (entry, ()) = tokio::join!(c.create_window("ssh-7", 120, 40, None), async {
            for body in [vec!["@2 %5"], vec![], vec![]] {
                let raw = cmd_rx.recv().await.expect("命令未发出");
                cmds.push(String::from_utf8_lossy(&raw).trim_end().to_string());
                c.dispatch_line(b"%begin 1 1 1");
                for line in &body {
                    c.dispatch_line(line.as_bytes());
                }
                c.dispatch_line(b"%end 1 1 1");
            }
        });

        let entry = entry.unwrap();
        assert_eq!(entry.window, WindowId(2));
        assert_eq!(entry.pane, PaneId(5));
        assert!(c.has_session("ssh-7"));

        assert_eq!(cmds.len(), 3);
        assert!(cmds[0].starts_with("new-window"));
        assert_eq!(cmds[1], "set-option -w -t @2 window-size manual");
        assert_eq!(cmds[2], "resize-window -t @2 -x 120 -y 40");
        assert!(
            !cmds.iter().any(|c| c.contains("-g window-size")),
            "global window-size 会崩溃 tmux 3.4+ 服务端"
        );
    }

    #[tokio::test]
    async fn create_window_rejects_malformed_reply() {
        let h = Harness::new();
        let result = drive(h.controller.create_window("ssh-8", 80, 24, None), async {
            tokio::task::yield_now().await;
            h.reply_ok(&["garbage"]);
        })
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn write_splits_into_send_keys_and_targets_pane() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(0), PaneId(3));
        h.controller.write("ssh-1", b"ls\r").unwrap();

        assert_eq!(h.sent_commands(), vec!["send-keys -t %3 -H 6c 73 0d"]);
    }

    #[test]
    fn first_cjk_write_bootstraps_old_posix_pane() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(0), PaneId(3));
        h.controller.write("ssh-1", "间".as_bytes()).unwrap();

        let cmds = h.sent_commands();
        assert!(
            cmds[0].starts_with("send-keys -t %3 -H 15"),
            "先 Ctrl+U 再 export/bind: {cmds:?}"
        );
        assert!(cmds[0].contains("62 69 6e 64"), "必须包含 bind: {cmds:?}");
        assert_eq!(cmds.last().unwrap(), "send-keys -t %3 -H e9 97 b4");

        h.controller.write("ssh-1", "间".as_bytes()).unwrap();
        assert_eq!(
            h.sent_commands(),
            vec!["send-keys -t %3 -H e9 97 b4".to_string()],
            "第二次不再注入 bind"
        );
    }

    #[test]
    fn resize_targets_window_of_session() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(6), PaneId(6));
        h.controller.resize("ssh-1", 100, 30).unwrap();

        assert_eq!(h.sent_commands(), vec!["resize-window -t @6 -x 100 -y 30"]);
    }

    #[test]
    fn operations_on_unknown_session_report_not_found() {
        let h = Harness::new();
        let err = h.controller.write("ghost", b"x").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(
            h.controller.resize("ghost", 80, 24).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[tokio::test]
    async fn capture_pane_joins_lines() {
        let h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(0), PaneId(0));
        let captured = drive(h.controller.capture_pane("ssh-1", 2000), async {
            tokio::task::yield_now().await;
            h.reply_ok(&["row-1", "row-2"]);
        })
        .await
        .unwrap();
        assert_eq!(captured, b"row-1\nrow-2".to_vec());
    }

    #[tokio::test]
    async fn close_window_kills_only_that_window() {
        let mut h = Harness::new();
        h.controller.adopt_window("ssh-1", WindowId(3), PaneId(3));
        h.controller.adopt_window("ssh-2", WindowId(4), PaneId(4));
        drive(h.controller.close_window("ssh-1"), async {
            tokio::task::yield_now().await;
            h.reply_ok(&[]);
        })
        .await
        .unwrap();

        assert_eq!(h.sent_commands(), vec!["kill-window -t @3"]);
        assert!(!h.controller.has_session("ssh-1"));
        assert!(h.controller.has_session("ssh-2"), "其他 Tab 不应受影响");
    }

    #[tokio::test]
    async fn list_sessions_parses_and_flags_managed() {
        let h = Harness::new();
        let sessions = drive(h.controller.list_sessions(), async {
            tokio::task::yield_now().await;
            h.reply_ok(&[
                "omnipanel-ws\t3\t1785484406\t1",
                "personal\t1\t1785400000\t0",
            ]);
        })
        .await
        .unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "omnipanel-ws");
        assert_eq!(sessions[0].windows, 3);
        assert_eq!(sessions[0].created, 1785484406);
        assert!(sessions[0].attached);
        assert!(sessions[0].managed);
        assert!(!sessions[1].attached);
        assert!(!sessions[1].managed, "非本应用创建的会话不应标记为受管");
    }

    #[tokio::test]
    async fn list_panes_parses_ids() {
        let h = Harness::new();
        let panes = drive(h.controller.list_panes("omnipanel-ws"), async {
            tokio::task::yield_now().await;
            h.reply_ok(&["@0\t%0\tbash", "@1\t%2\tvim", "garbage"]);
        })
        .await
        .unwrap();
        assert_eq!(
            panes,
            vec![
                (WindowId(0), PaneId(0), "bash".to_string()),
                (WindowId(1), PaneId(2), "vim".to_string()),
            ]
        );
    }
}
