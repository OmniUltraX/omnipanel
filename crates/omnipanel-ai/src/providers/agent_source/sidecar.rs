//! 宿主侧 Agent sidecar 客户端。一个来源一个长驻进程，请求串行。

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use reqwest::Client;
use serde_json::{Value, json};
use tokio_stream::wrappers::ReceiverStream;

use crate::ir::StreamEvent;
use crate::provider::AiProvider;
use crate::types::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, Usage};

use super::{AgentSource, AgentSourceCard};

use omnipanel_agent_proto::{
    Incoming, PROTOCOL_VERSION, ReadJson, parse_message, read_json_line, request_value,
    write_json_line,
};

enum CallError {
    Io(String),
    Rpc(String),
}

struct SidecarSession {
    program: PathBuf,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: i64,
}

impl Drop for SidecarSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl SidecarSession {
    fn spawn(program: &Path) -> Result<Self, String> {
        let mut child = launch_command(program)
            .spawn()
            .map_err(|err| format!("启动 sidecar 失败 ({}): {err}", program.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar 没有 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar 没有 stdout".to_string())?;
        let mut session = Self {
            program: program.to_path_buf(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        if let Err(err) = session.handshake() {
            let _ = session.child.kill();
            return Err(err);
        }
        Ok(session)
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn handshake(&mut self) -> Result<(), String> {
        let result = self.call("handshake", json!({})).map_err(|err| match err {
            CallError::Io(message) | CallError::Rpc(message) => message,
        })?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if version != PROTOCOL_VERSION {
            return Err(format!("不支持的 agent sidecar 协议版本 {version}"));
        }
        Ok(())
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_request(id, method, params)?;
        self.read_until(id, |_| {})
    }

    fn chat(
        &mut self,
        model: &str,
        request: &ChatRequest,
        proxy: &Value,
        mut on_event: impl FnMut(StreamEvent),
    ) -> Result<(), CallError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_request(
            id,
            "chat",
            json!({
                "model": model,
                "request": request,
                "proxy": proxy,
            }),
        )?;
        self.read_until(id, |event| on_event(event))?;
        Ok(())
    }

    fn write_request(&mut self, id: i64, method: &str, params: Value) -> Result<(), CallError> {
        write_json_line(&mut self.stdin, &request_value(id, method, params))
            .map_err(|err| CallError::Io(format!("写入 sidecar 失败: {err}")))
    }

    fn read_until(
        &mut self,
        id: i64,
        mut on_event: impl FnMut(StreamEvent),
    ) -> Result<Value, CallError> {
        loop {
            match read_json_line(&mut self.stdout) {
                Ok(ReadJson::Eof) => return Err(CallError::Io("sidecar 已退出".into())),
                Ok(ReadJson::Invalid(message)) => {
                    return Err(CallError::Io(format!("sidecar 输出不是 JSON: {message}")));
                }
                Err(err) => return Err(CallError::Io(format!("读取 sidecar 失败: {err}"))),
                Ok(ReadJson::Value(value)) => match parse_message(&value) {
                    Ok(Incoming::ChatEvent { id: got, event }) if got == id => {
                        let event = serde_json::from_value::<StreamEvent>(event)
                            .map_err(|err| CallError::Io(format!("chat_event 无法解析: {err}")))?;
                        on_event(event);
                    }
                    Ok(Incoming::Response { id: got, result }) if got == id => return Ok(result),
                    Ok(Incoming::Failure { id: got, message }) if got == id => {
                        return Err(CallError::Rpc(message));
                    }
                    Ok(Incoming::ChatEvent { .. }) => {}
                    Ok(other) => {
                        return Err(CallError::Io(format!("sidecar 协议错位: {other:?}")));
                    }
                    Err(message) => return Err(CallError::Io(message)),
                },
            }
        }
    }
}

struct SharedSession {
    inner: Mutex<Option<SidecarSession>>,
}

impl SharedSession {
    fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    fn with_program<T>(
        &self,
        program: &Path,
        body: impl FnOnce(&mut SidecarSession) -> Result<T, CallError>,
    ) -> Result<T, String> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stale = match guard.as_mut() {
            Some(session) => !session.alive() || session.program != program,
            None => true,
        };
        if stale {
            *guard = Some(SidecarSession::spawn(program)?);
        }
        let session = guard.as_mut().expect("sidecar session");
        match body(session) {
            Ok(value) => Ok(value),
            Err(CallError::Rpc(message)) => Err(message),
            Err(CallError::Io(message)) => {
                *guard = None;
                Err(message)
            }
        }
    }
}

enum ProgramKind {
    Official {
        bin_name: &'static str,
        package_name: &'static str,
        plugin_dir: &'static str,
        driver: &'static str,
        env_var: &'static str,
    },
    Explicit(PathBuf),
}

pub struct SidecarSource {
    id: String,
    title: String,
    origin: &'static str,
    program: ProgramKind,
    session: Arc<SharedSession>,
    cache: Mutex<Option<AgentSourceCard>>,
    proxy: Mutex<Value>,
}

impl SidecarSource {
    fn official(
        id: &'static str,
        title: &'static str,
        bin_name: &'static str,
        package_name: &'static str,
        plugin_dir: &'static str,
        driver: &'static str,
        env_var: &'static str,
        origin: &'static str,
    ) -> Self {
        Self {
            id: id.to_string(),
            title: title.to_string(),
            origin,
            program: ProgramKind::Official {
                bin_name,
                package_name,
                plugin_dir,
                driver,
                env_var,
            },
            session: Arc::new(SharedSession::new()),
            cache: Mutex::new(None),
            proxy: Mutex::new(Value::Null),
        }
    }

    pub fn workbuddy() -> Self {
        Self::official(
            "workbuddy",
            "WorkBuddy",
            "omnipanel-agent-workbuddy",
            "omnipanel-agent-workbuddy",
            "agent-workbuddy",
            "bin/omnipanel-agent-workbuddy",
            "OMNIPANEL_AGENT_WORKBUDDY_BIN",
            "https://copilot.tencent.com",
        )
    }

    pub fn cursor() -> Self {
        Self::official(
            "cursor",
            "Cursor",
            "omnipanel-agent-cursor",
            "omnipanel-agent-cursor",
            "agent-cursor",
            "bin/omnipanel-agent-cursor",
            "OMNIPANEL_AGENT_CURSOR_BIN",
            "https://agentn.global.api5.cursor.sh",
        )
    }

    pub fn trae() -> Self {
        Self::official(
            "trae",
            "Trae",
            "omnipanel-agent-trae",
            "omnipanel-agent-trae",
            "agent-trae",
            "bin/omnipanel-agent-trae",
            "OMNIPANEL_AGENT_TRAE_BIN",
            "https://trae-api-cn.mchost.guru",
        )
    }

    pub fn trae_global() -> Self {
        Self::official(
            "trae-global",
            "Trae 国际版",
            "omnipanel-agent-trae-global",
            "omnipanel-agent-trae",
            "agent-trae-global",
            "bin/omnipanel-agent-trae-global",
            "OMNIPANEL_AGENT_TRAE_GLOBAL_BIN",
            "https://coresg-normal.trae.ai",
        )
    }

    pub fn explicit(id: String, title: String, program: PathBuf) -> Self {
        let title = if title.trim().is_empty() {
            id.clone()
        } else {
            title
        };
        Self {
            id,
            title,
            origin: "https://localhost",
            program: ProgramKind::Explicit(program),
            session: Arc::new(SharedSession::new()),
            cache: Mutex::new(None),
            proxy: Mutex::new(Value::Null),
        }
    }

    fn resolve_program(&self) -> Result<PathBuf, String> {
        match &self.program {
            ProgramKind::Explicit(path) => {
                if path.is_file() {
                    Ok(path.clone())
                } else {
                    Err(format!("未找到 {} sidecar: {}", self.title, path.display()))
                }
            }
            ProgramKind::Official {
                bin_name,
                package_name,
                plugin_dir,
                driver,
                env_var,
            } => resolve_official(
                *bin_name,
                *package_name,
                *plugin_dir,
                *driver,
                *env_var,
                &self.title,
            ),
        }
    }

    fn offline_card(&self, message: String) -> AgentSourceCard {
        AgentSourceCard {
            id: self.id.clone(),
            title: self.title.clone(),
            signed_in: false,
            account: None,
            token_expires_at_ms: None,
            catalog_source: "none".into(),
            error: Some(message),
            models: Vec::new(),
            credits: None,
        }
    }

    fn normalize(&self, mut card: AgentSourceCard) -> AgentSourceCard {
        card.id = self.id.clone();
        if card.title.trim().is_empty() {
            card.title = self.title.clone();
        }
        card
    }

    fn rpc_card(&self, method: &str) -> Result<AgentSourceCard, String> {
        let program = self.resolve_program()?;
        let proxy = self
            .proxy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let value = self.session.with_program(&program, |session| {
            session.call(method, json!({ "proxy": proxy }))
        })?;
        let card = serde_json::from_value::<AgentSourceCard>(value)
            .map_err(|err| format!("{method} 结果无法解析: {err}"))?;
        Ok(self.normalize(card))
    }

    fn store_cache(&self, card: &AgentSourceCard) {
        *self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(card.clone());
    }
}

impl AgentSource for SidecarSource {
    fn id(&self) -> &str {
        &self.id
    }

    fn title(&self) -> &str {
        &self.title
    }

    fn card(&self) -> AgentSourceCard {
        if let Some(card) = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            return card;
        }
        match self.rpc_card("status") {
            Ok(card) => {
                self.store_cache(&card);
                card
            }
            Err(err) => self.offline_card(err),
        }
    }

    fn refresh(&self) -> Result<AgentSourceCard, String> {
        let card = self.rpc_card("catalog")?;
        self.store_cache(&card);
        Ok(card)
    }

    fn upstream_origin(&self) -> &'static str {
        self.origin
    }

    fn set_request_proxy(&self, proxy: &Value) {
        *self
            .proxy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = proxy.clone();
    }

    fn open_provider(
        &self,
        model_id: &str,
        _client: Client,
    ) -> Result<Box<dyn AiProvider>, String> {
        let program = self.resolve_program()?;
        let proxy = self
            .proxy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        Ok(Box::new(SidecarChat {
            session: Arc::clone(&self.session),
            program,
            model: model_id.to_string(),
            proxy,
        }))
    }
}

struct SidecarChat {
    session: Arc<SharedSession>,
    program: PathBuf,
    model: String,
    proxy: Value,
}

#[async_trait::async_trait]
impl AiProvider for SidecarChat {
    fn name(&self) -> &str {
        "agent-sidecar"
    }

    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            id: self.model.clone(),
            name: self.model.clone(),
            provider: "agent".into(),
            context_window: None,
        }]
    }

    async fn chat(&self, request: ChatRequest) -> anyhow::Result<ChatResponse> {
        let mut stream = self.chat_stream(request).await?;
        let mut content = String::new();
        use futures::StreamExt;
        while let Some(event) = stream.next().await {
            if let Ok(StreamEvent::ContentDelta { text }) = event {
                content.push_str(&text);
            }
        }
        Ok(ChatResponse {
            message: ChatMessage {
                role: Role::Assistant,
                content,
                tool_call_id: None,
                tool_calls: None,
                name: None,
            },
            usage: Usage::default(),
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> anyhow::Result<
        std::pin::Pin<Box<dyn futures::Stream<Item = anyhow::Result<StreamEvent>> + Send>>,
    > {
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let session = Arc::clone(&self.session);
        let program = self.program.clone();
        let model = self.model.clone();
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let result = session.with_program(&program, |sidecar| {
                sidecar.chat(&model, &request, &proxy, |event| {
                    let _ = tx.blocking_send(Ok(event));
                })
            });
            if let Err(err) = result {
                let _ = tx.blocking_send(Ok(StreamEvent::Error { message: err }));
            }
        });
        Ok(Box::pin(ReceiverStream::new(rx)))
    }
}

pub struct InstalledAgentSidecar {
    pub source_id: String,
    pub title: String,
    pub program: PathBuf,
}

pub fn sync_installed_agent_sidecars(installed: Vec<InstalledAgentSidecar>) {
    let sources = installed
        .into_iter()
        .map(|item| {
            Arc::new(SidecarSource::explicit(
                item.source_id,
                item.title,
                item.program,
            )) as Arc<dyn AgentSource>
        })
        .collect();
    super::agent_source_registry().sync_unpinned(sources);
}

fn resolve_official(
    bin_name: &str,
    package_name: &str,
    plugin_dir: &str,
    driver: &str,
    env_var: &str,
    title: &str,
) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(env_var) {
        let path = PathBuf::from(raw.trim());
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("{env_var} 指向的文件不存在: {}", path.display()));
    }
    let mut missing = Vec::new();
    for candidate in official_candidates(bin_name, plugin_dir, driver) {
        if candidate.is_file() {
            return Ok(candidate);
        }
        missing.push(candidate.display().to_string());
    }
    Err(format!(
        "未找到 {title} sidecar。请先 cargo build -p {package_name}。已查找：{}",
        missing.join("; ")
    ))
}

fn official_candidates(bin_name: &str, plugin_dir: &str, driver: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.extend(named_bins(dir, bin_name));
        }
    }
    let plugin = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../plugins")
        .join(plugin_dir)
        .join(driver);
    out.extend(with_exe(plugin));
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target");
    let prefer_release = std::env::current_exe()
        .ok()
        .map(|path| {
            path.to_string_lossy()
                .to_ascii_lowercase()
                .contains("release")
        })
        .unwrap_or(false);
    let profiles: &[&str] = if prefer_release {
        &["release", "debug"]
    } else {
        &["debug", "release"]
    };
    for profile in profiles {
        out.extend(named_bins(&target.join(profile), bin_name));
    }
    out
}

fn named_bins(dir: &Path, bin_name: &str) -> Vec<PathBuf> {
    with_exe(dir.join(bin_name))
}

fn with_exe(path: PathBuf) -> Vec<PathBuf> {
    let mut out = vec![path.clone()];
    #[cfg(windows)]
    if path.extension().is_none() {
        let mut exe = path;
        exe.set_extension("exe");
        out.push(exe);
    }
    out
}

fn launch_command(program: &Path) -> Command {
    let ext = program
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut cmd = match ext.as_str() {
        "js" | "mjs" => {
            let mut cmd = Command::new("node");
            cmd.arg(program);
            cmd
        }
        "jar" => {
            let mut cmd = Command::new("java");
            cmd.arg("-Dfile.encoding=UTF-8").arg("-jar").arg(program);
            cmd
        }
        _ => Command::new(program),
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_existing_file_wins() {
        let file = std::env::temp_dir().join(format!(
            "omni-agent-sidecar-{}-probe.txt",
            std::process::id()
        ));
        std::fs::write(&file, b"ok").unwrap();
        let missing = file.with_extension("missing");
        let found = [missing, file.clone()]
            .into_iter()
            .find(|path| path.is_file());
        assert_eq!(found.as_ref(), Some(&file));
        let _ = std::fs::remove_file(&file);
    }
}
