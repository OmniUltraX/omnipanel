//! Web 插件运行时：与桌面共用 `omnipanel-plugin-host`。
//! 确认事件名仍是 `plugin://confirm-request`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use omnipanel_error::OmniError;
use omnipanel_plugin::{
    ConfirmFuture, ConfirmRequest, InvokeGateway, PluginLogicExecutor, PluginLogicInstance,
    PluginMethodDecl, PluginRegistry, ProdConfirmer,
};
use omnipanel_plugin_host::{
    PluginBridge, SshExec, activate_current, block_on_detached, build_plugin_registry,
    enter_injected_connection, make_logic_executor,
};
use omnipanel_store::{AuditEntry, Connection, ConnectionKind, Storage};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::bus::EventBus;

pub const PLUGIN_CONFIRM_REQUEST_EVENT: &str = "plugin://confirm-request";
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmRequestPayload {
    request_id: String,
    plugin_id: String,
    action: String,
    target: String,
}

pub struct PendingPluginConfirm {
    pub tx: tokio::sync::oneshot::Sender<bool>,
    pub grant_target: String,
}

struct WebProdConfirmer {
    bus: EventBus,
    pending: Arc<Mutex<HashMap<String, PendingPluginConfirm>>>,
}

impl ProdConfirmer for WebProdConfirmer {
    fn confirm(&self, req: ConfirmRequest) -> ConfirmFuture {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        let request_id = uuid_v4();
        let grant_target =
            omnipanel_presence::pipe_target(&[&req.plugin_id, &req.action, &req.target]);
        let payload = ConfirmRequestPayload {
            request_id: request_id.clone(),
            plugin_id: req.plugin_id,
            action: req.action,
            target: req.target,
        };
        let pending = Arc::clone(&self.pending);
        let bus = self.bus.clone();
        let rid = request_id.clone();
        Box::pin(async move {
            pending.lock().await.insert(
                rid.clone(),
                PendingPluginConfirm { tx, grant_target },
            );
            bus.emit(
                PLUGIN_CONFIRM_REQUEST_EVENT,
                serde_json::to_value(&payload).unwrap_or(Value::Null),
            );
            let allowed = matches!(
                tokio::time::timeout(CONFIRM_TIMEOUT, rx).await,
                Ok(Ok(true))
            );
            let _ = pending.lock().await.remove(&rid);
            Ok(allowed)
        })
    }
}

/// 桌面安装目录（Tauri `app_data_dir/plugins`）。Web 读同一处，才能跑已安装的 L2。
pub fn user_plugins_dir() -> Option<PathBuf> {
    let id = "com.omnipanel.app";
    #[cfg(windows)]
    {
        return std::env::var_os("APPDATA")
            .map(|appdata| PathBuf::from(appdata).join(id).join("plugins"));
    }
    #[cfg(target_os = "macos")]
    {
        return home_dir().map(|home| {
            home.join("Library")
                .join("Application Support")
                .join(id)
                .join("plugins")
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".local").join("share")));
        return base.map(|dir| dir.join(id).join("plugins"));
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(not(windows))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub struct WebSshExec {
    pub ssh_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
    pub docker_ssh_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
    pub storage: Arc<Mutex<Storage>>,
}

impl SshExec for WebSshExec {
    fn exec(
        &self,
        connection_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let sessions = Arc::clone(&self.ssh_sessions);
        let docker = Arc::clone(&self.docker_ssh_sessions);
        let storage = Arc::clone(&self.storage);
        let connection_id = connection_id.to_string();
        let command = command.to_string();
        block_on_detached(async move {
            let session = if let Some(session) = sessions.lock().await.get(&connection_id) {
                session.clone()
            } else if let Some(session) = docker.lock().await.get(&connection_id) {
                session.clone()
            } else {
                let conn = storage
                    .lock()
                    .await
                    .get_connection(&connection_id)
                    .map_err(|err| err.to_string())?
                    .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
                let config =
                    crate::state::resolve_ssh_config(&conn).map_err(|err| err.to_string())?;
                Arc::new(
                    omnipanel_ssh::SshSession::connect_no_shell(config)
                        .await
                        .map_err(|err| err.to_string())?,
                )
            };
            let output = tokio::time::timeout(timeout, session.exec_capture(&command))
                .await
                .map_err(|_| "sshExec 超时".to_string())?
                .map_err(|err| err.to_string())?;
            Ok(serde_json::json!({
                "stdout": output.stdout,
                "stderr": output.stderr,
                "exitCode": output.exit_code,
            })
            .to_string())
        })
    }
}

pub struct PluginRuntime {
    pub registry: Arc<Mutex<PluginRegistry>>,
    pub gateway: Arc<InvokeGateway>,
    pub packages_dir: Option<PathBuf>,
    pub executor: Arc<dyn PluginLogicExecutor>,
    pub instances: Arc<
        std::sync::Mutex<
            HashMap<String, Arc<std::sync::Mutex<Box<dyn PluginLogicInstance>>>>,
        >,
    >,
    pub pending_confirms: Arc<Mutex<HashMap<String, PendingPluginConfirm>>>,
    pub http: reqwest::Client,
    pub storage: Arc<Mutex<Storage>>,
    pub ssh: Arc<dyn SshExec>,
    pub confirmer: Arc<dyn ProdConfirmer>,
    pub presence: Arc<omnipanel_presence::TokenStore>,
}

impl PluginRuntime {
    pub fn seed(
        storage: Arc<Mutex<Storage>>,
        bus: EventBus,
        ssh_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
        docker_ssh_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
        presence: Arc<omnipanel_presence::TokenStore>,
    ) -> Self {
        let packages_dir = user_plugins_dir();
        if let Some(root) = packages_dir.as_deref() {
            let _ = omnipanel_plugin_pkg::cleanup_staging_root(root);
        }
        let mut registry = build_plugin_registry(packages_dir.as_deref());
        if let Ok(store) = storage.try_lock() {
            if let Ok(saved) = store.plugin_enabled_list() {
                for (id, enabled) in saved {
                    let _ = registry.set_enabled(&id, enabled);
                }
            }
        }
        activate_current(&mut registry);
        let pending_confirms = Arc::new(Mutex::new(HashMap::new()));
        let ssh: Arc<dyn SshExec> = Arc::new(WebSshExec {
            ssh_sessions,
            docker_ssh_sessions,
            storage: Arc::clone(&storage),
        });
        let confirmer: Arc<dyn ProdConfirmer> = Arc::new(WebProdConfirmer {
            bus,
            pending: Arc::clone(&pending_confirms),
        });
        let runtime = Self {
            registry: Arc::new(Mutex::new(registry)),
            gateway: Arc::new(InvokeGateway::new()),
            packages_dir,
            executor: make_logic_executor(),
            instances: Arc::new(std::sync::Mutex::new(HashMap::new())),
            pending_confirms,
            http: reqwest::Client::new(),
            storage,
            ssh,
            confirmer,
            presence,
        };
        runtime.sync_logic_blocking();
        runtime
    }

    fn sync_logic_blocking(&self) {
        let wanted: Vec<(String, String)> = {
            let registry = match self.registry.try_lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            registry
                .list()
                .into_iter()
                .filter(|item| item.activated)
                .filter_map(|item| {
                    registry
                        .get(&item.id)
                        .and_then(|entry| entry.manifest.logic_entry().map(|p| (item.id, p.to_string())))
                })
                .collect()
        };
        for (plugin_id, logic_rel) in wanted {
            if self
                .instances
                .lock()
                .unwrap()
                .contains_key(&plugin_id)
            {
                continue;
            }
            let disk = self
                .packages_dir
                .as_ref()
                .map(|root| root.join(&plugin_id).join(&logic_rel));
            let bytes = match disk.as_ref() {
                Some(path) => std::fs::read(path)
                    .ok()
                    .or_else(|| omnipanel_plugin::first_party_logic_bytes(&plugin_id, &logic_rel)),
                None => omnipanel_plugin::first_party_logic_bytes(&plugin_id, &logic_rel),
            };
            let Some(bytes) = bytes else {
                continue;
            };
            if logic_rel.to_ascii_lowercase().ends_with(".js") && bytes.len() > 2 * 1024 * 1024 {
                continue;
            }
            let bridge = Arc::new(self.bridge_for(&plugin_id));
            let package = omnipanel_plugin::LogicPackage::from_entry_bytes(&logic_rel, bytes);
            match self.executor.instantiate(&plugin_id, &package, bridge) {
                Ok(instance) => {
                    self.instances.lock().unwrap().insert(
                        plugin_id,
                        Arc::new(std::sync::Mutex::new(instance)),
                    );
                }
                Err(err) => eprintln!("[plugin-logic] Web 实例化失败 {plugin_id}: {err}"),
            }
        }
    }

    fn bridge_for(&self, plugin_id: &str) -> PluginBridge {
        PluginBridge {
            plugin_id: plugin_id.to_string(),
            registry: Arc::clone(&self.registry),
            storage: Arc::clone(&self.storage),
            gateway: Arc::clone(&self.gateway),
            fs_root: self
                .packages_dir
                .as_ref()
                .map(|root| root.join(plugin_id)),
            http: self.http.clone(),
            confirmer: Arc::clone(&self.confirmer),
            ssh: Arc::clone(&self.ssh),
        }
    }

    pub async fn invoke(
        &self,
        plugin_id: String,
        method: String,
        mut args: Value,
    ) -> Result<Value, OmniError> {
        if let Some(connection_id) = args
            .get("connectionId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        {
            let storage = self.storage.lock().await;
            if let Ok(Some(conn)) = storage.get_connection(&connection_id) {
                merge_service_connection_args(&mut args, &plugin_id, &conn);
            }
        }
        let decl: PluginMethodDecl = {
            let registry = self.registry.lock().await;
            registry.declared_method(&plugin_id, &method)?
        };
        {
            let registry = self.registry.lock().await;
            for permission in &decl.permissions {
                registry.require_permission(&plugin_id, *permission)?;
            }
        }
        if let Some(action) = decl.danger_action.as_deref().filter(|s| !s.is_empty()) {
            let token = args.get("presenceToken").and_then(|v| v.as_str());
            let target = args
                .get("presenceTarget")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            omnipanel_presence::require_grant(&self.presence, token, action, target)?;
        }
        let native = self
            .gateway
            .invoke(&plugin_id, &method, args.clone())
            .await;
        let result = match native {
            Err(omnipanel_plugin::PluginError::UnknownMethod { .. }) => {
                let instance = self.instances.lock().unwrap().get(&plugin_id).cloned();
                match instance {
                    Some(instance) => {
                        let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "{}".into());
                        let method = method.clone();
                        let injected = args
                            .get("connectionId")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        tokio::task::spawn_blocking(move || {
                            let _ssh = enter_injected_connection(injected);
                            let guard = instance.lock().unwrap();
                            let rt = tokio::runtime::Handle::current();
                            rt.block_on(guard.call(&method, &args_json))
                        })
                        .await
                        .map_err(|e| OmniError::internal(e.to_string()))?
                        .and_then(|text| {
                            serde_json::from_str::<Value>(&text).map_err(|e| {
                                omnipanel_plugin::PluginError::Invoke(format!("L2 结果非 JSON: {e}"))
                            })
                        })
                    }
                    None => Err(omnipanel_plugin::PluginError::Invoke(format!(
                        "逻辑包未实例化: {plugin_id}"
                    ))),
                }
            }
            other => other,
        };
        let status = if result.is_ok() { "success" } else { "failed" };
        let detail = match &result {
            Ok(_) => format!("{method} {}", args_digest(&args)),
            Err(err) => format!("{method} {} err={err}", args_digest(&args)),
        };
        self.audit(&plugin_id, status, detail).await;
        result.map_err(Into::into)
    }

    pub async fn confirm_resolve(
        &self,
        request_id: &str,
        allow: bool,
        presence_token: Option<&str>,
    ) -> Result<(), OmniError> {
        let pending = self.pending_confirms.lock().await.remove(request_id);
        match pending {
            Some(pending) => {
                if allow {
                    omnipanel_presence::require_grant(
                        &self.presence,
                        presence_token,
                        omnipanel_presence::ACTION_PLUGIN_HOST,
                        &pending.grant_target,
                    )?;
                }
                let _ = pending.tx.send(allow);
                Ok(())
            }
            None => Err(OmniError::not_found(format!(
                "确认请求不存在或已超时: {request_id}"
            ))),
        }
    }

    async fn audit(&self, target: &str, status: &str, detail: String) {
        let entry = AuditEntry {
            ts: now_ms(),
            action: "plugin.invoke".into(),
            target: target.to_string(),
            env_tag: String::new(),
            risk: "medium".into(),
            status: status.into(),
            detail,
        };
        if let Ok(store) = self.storage.try_lock() {
            let _ = store.append_audit(&entry);
        }
    }
}

fn merge_service_connection_args(args: &mut Value, plugin_id: &str, conn: &Connection) {
    if conn.kind != ConnectionKind::Service {
        return;
    }
    let parsed: Value =
        serde_json::from_str(&conn.config).unwrap_or_else(|_| Value::Object(Default::default()));
    let cfg_plugin = parsed
        .get("pluginId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !cfg_plugin.is_empty() && cfg_plugin != plugin_id {
        return;
    }
    let Value::Object(map) = args else {
        return;
    };
    if let Value::Object(cfg) = parsed {
        for (key, value) in cfg {
            map.entry(key).or_insert(value);
        }
    }
    map.entry("passwordKey")
        .or_insert(Value::String(conn.id.clone()));
    map.entry("connectionId")
        .or_insert(Value::String(conn.id.clone()));
    if !conn.env_tag.is_empty() {
        map.entry("envTag")
            .or_insert(Value::String(conn.env_tag.clone()));
    }
}

fn args_digest(args: &Value) -> String {
    let serialized = serde_json::to_string(args).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    format!("sha256:{:x} len={}", hasher.finalize(), serialized.len())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    for (i, byte) in ts.to_le_bytes().iter().enumerate() {
        b[i] = *byte;
    }
    for (i, byte) in std::process::id().to_le_bytes().iter().enumerate() {
        b[12 + i] = *byte;
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = |slice: &[u8]| -> String { slice.iter().map(|x| format!("{x:02x}")).collect() };
    format!(
        "{}-{}-{}-{}-{}",
        hex(&b[0..4]),
        hex(&b[4..6]),
        hex(&b[6..8]),
        hex(&b[8..10]),
        hex(&b[10..16])
    )
}
