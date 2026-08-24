//! L2 宿主能力桥装配：权限闸内联、fs 目录禁锢、prod 交互确认、审计。
//!
//! 安全规则：
//! - 每个能力先过清单 `permissions`（缺权即拒，稳定错误文本）；
//! - `fs_read` 只允许读取插件自身安装目录（`packages_dir/<plugin_id>`）内的文件；
//! - `net_fetch` 解析 URL 主机名，命中任一 env_tag=prod 连接的目标主机时
//!   必须经 [`ProdConfirmer`] 交互确认；60s 无响应视为拒绝；
//! - 全部动作写 audit_log（参数只存 sha256+len 摘要）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use omnipanel_plugin::{
    ConfirmFuture, ConfirmRequest, InvokeGateway, PluginError, PluginHostBridge, PluginPermission,
    PluginRegistry, ProdConfirmer,
};
use omnipanel_store::{AuditEntry, Storage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

pub const PLUGIN_CONFIRM_REQUEST_EVENT: &str = "plugin://confirm-request";
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmRequestPayload {
    pub request_id: String,
    pub plugin_id: String,
    pub action: String,
    pub target: String,
}

/// 交互式确认器：emit 事件 + oneshot 回传；超时自动拒绝。
pub struct TauriProdConfirmer {
    pub app: AppHandle,
    pub pending:
        Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
}

impl ProdConfirmer for TauriProdConfirmer {
    fn confirm(&self, req: ConfirmRequest) -> ConfirmFuture {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        let request_id = uuid_v4();
        let payload = ConfirmRequestPayload {
            request_id: request_id.clone(),
            plugin_id: req.plugin_id,
            action: req.action,
            target: req.target,
        };
        let pending = Arc::clone(&self.pending);
        let app = self.app.clone();
        let rid = request_id.clone();
        Box::pin(async move {
            {
                let mut guard = pending.lock().await;
                // 同 requestId 竞争时后到者替换（幂等保护）
                guard.insert(rid.clone(), tx);
            }
            let _ = app.emit(PLUGIN_CONFIRM_REQUEST_EVENT, &payload);
            match tokio::time::timeout(CONFIRM_TIMEOUT, rx).await {
                Ok(Ok(allowed)) => Ok(allowed),
                _ => {
                    let _ = pending.lock().await.remove(&rid);
                    Ok(false) // 超时/通道关闭 = 拒绝
                }
            }
        })
    }
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    if let Ok(data) = std::fs::read("/dev/urandom") {
        for (i, byte) in data.iter().take(16).enumerate() {
            b[i] = *byte;
        }
    } else {
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
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = |slice: &[u8]| -> String {
        slice.iter().map(|x| format!("{x:02x}")).collect()
    };
    format!(
        "{}-{}-{}-{}-{}",
        hex(&b[0..4]),
        hex(&b[4..6]),
        hex(&b[6..8]),
        hex(&b[8..10]),
        hex(&b[10..16])
    )
}

/// L2 能力桥。所有方法同步（wasm/js 引擎在 spawn_blocking 内调用），
/// 内部经 tokio Handle 访问异步锁。
pub struct PluginBridge {
    pub plugin_id: String,
    pub registry: Arc<tokio::sync::Mutex<PluginRegistry>>,
    pub storage: Arc<tokio::sync::Mutex<Storage>>,
    pub gateway: Arc<InvokeGateway>,
    /// fs 禁锢根：packages_dir/<plugin_id>
    pub fs_root: Option<PathBuf>,
    pub http: reqwest::Client,
    pub confirmer: Arc<dyn ProdConfirmer>,
}

#[derive(Debug, Deserialize)]
struct NetSpec {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

fn args_digest(payload: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    format!("sha256:{:x} len={}", hasher.finalize(), payload.len())
}

impl PluginBridge {
    fn require(
        &self,
        permission: PluginPermission,
    ) -> Result<(), PluginError> {
        let rt = tokio::runtime::Handle::current();
        let registry = Arc::clone(&self.registry);
        rt.block_on(async move {
            let guard = registry.lock().await;
            guard.require_permission(&self.plugin_id, permission)
        })
    }

    fn audit(&self, action: &str, status: &str, detail: String) {
        let rt = tokio::runtime::Handle::current();
        let storage = Arc::clone(&self.storage);
        let plugin_id = self.plugin_id.clone();
        let action = action.to_string();
        let status = status.to_string();
        rt.block_on(async move {
            let store = storage.lock().await;
            let _ = store.append_audit(&AuditEntry {
                ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
                action,
                target: plugin_id,
                env_tag: "-".into(),
                risk: "medium".into(),
                status,
                detail: detail.chars().take(200).collect(),
            });
        });
    }

    /// URL 是否命中 prod 标记的连接目标主机。
    fn is_prod_target(&self, host: &str) -> Result<bool, PluginError> {
        let rt = tokio::runtime::Handle::current();
        let storage = Arc::clone(&self.storage);
        let host = host.to_ascii_lowercase();
        rt.block_on(async move {
            let store = storage.lock().await;
            let conns = store.list_connections().map_err(|e| {
                PluginError::Invoke(format!("读取连接失败: {e}"))
            })?;
            Ok(conns.iter().any(|conn| {
                conn.env_tag.eq_ignore_ascii_case("prod")
                    && config_hosts(&conn.config)
                        .into_iter()
                        .any(|h| h.eq_ignore_ascii_case(&host))
            }))
        })
    }

    async fn prod_gate(&self, action: &str, target: &str) -> Result<(), PluginError> {
        let Some(host) = extract_host(target) else {
            return Ok(());
        };
        if !self.is_prod_target(&host)? {
            return Ok(());
        }
        let allowed = self
            .confirmer
            .confirm(ConfirmRequest {
                plugin_id: self.plugin_id.clone(),
                action: action.to_string(),
                target: target.to_string(),
            })
            .await
            .unwrap_or(false);
        self.audit(
            "plugin.prod-confirm",
            if allowed { "allowed" } else { "blocked" },
            format!("{action} {target}"),
        );
        if allowed {
            Ok(())
        } else {
            Err(PluginError::Invoke(format!(
                "已拦截对生产环境目标的访问（未获用户确认）: {target}"
            )))
        }
    }
}

/// 从连接 config JSON 中提取可能的主机字段（host/address）。
fn config_hosts(config_json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(config_json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in ["host", "address"] {
        if let Some(s) = value.get(key).and_then(|v| v.as_str()) {
            if let Some(host) = extract_host(s).or_else(|| normalize_bare(s)) {
                out.push(host);
            }
        }
    }
    out
}

/// 从 URL 提取主机名（支持 scheme://host[:port]/path）。
fn extract_host(target: &str) -> Option<String> {
    let after_scheme = target.split("://").nth(1).unwrap_or(target);
    let host_port = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    let host = host_port.rsplit_once('@').map_or(host_port, |(_, h)| h);
    let host = host.strip_prefix('[').map_or(host, |rest| {
        rest.split(']').next().unwrap_or(rest)
    });
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 裸主机/IP 归一化（去端口、去路径、小写）。
fn normalize_bare(value: &str) -> Option<String> {
    extract_host(value.trim())
}

impl PluginHostBridge for PluginBridge {
    fn ping(&self) -> i32 {
        1
    }

    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        self.require(PluginPermission::NetConnect).map_err(|e| e.to_string())?;
        let spec: NetSpec = serde_json::from_str(spec_json)
            .map_err(|e| format!("netFetch 参数需为 {{url, headers?}} JSON: {e}"))?;

        // prod 闸是异步的，这里用独立 runtime 桥接同步边界
        let gate_bridge = Self {
            plugin_id: self.plugin_id.clone(),
            registry: Arc::clone(&self.registry),
            storage: Arc::clone(&self.storage),
            gateway: Arc::clone(&self.gateway),
            fs_root: self.fs_root.clone(),
            http: self.http.clone(),
            confirmer: Arc::clone(&self.confirmer),
        };
        let gate_target = spec.url.clone();
        let rt = tokio::runtime::Handle::current();
        rt.block_on(gate_bridge.prod_gate("net.fetch", &gate_target))
            .map_err(|e| e.to_string())?;

        let mut request = self.http.get(&spec.url);
        for (key, value) in &spec.headers {
            request = request.header(key, value);
        }
        let response = rt
            .block_on(async move { request.send().await?.error_for_status() })
            .map_err(|e| format!("请求失败: {e}"))?;
        let body = rt
            .block_on(async move { response.text().await })
            .map_err(|e| format!("读取响应失败: {e}"))?;
        self.audit("plugin.net", "success", args_digest(spec_json));
        Ok(body)
    }

    fn fs_read(&self, path: &str) -> Result<String, String> {
        self.require(PluginPermission::FsRead).map_err(|e| e.to_string())?;
        let root = self.fs_root.as_ref().ok_or("插件安装目录不可用")?;
        let requested = PathBuf::from(path);
        let canonical_requested = dedot(&requested);
        let canonical_root = dedot(root);
        if !canonical_requested.starts_with(&canonical_root) {
            self.audit("plugin.fs", "blocked", path.to_string());
            return Err(format!("fsRead 仅允许访问插件自身目录: {path}"));
        }
        let text = std::fs::read_to_string(&canonical_requested)
            .map_err(|e| format!("读取失败: {e}"))?;
        self.audit("plugin.fs", "success", args_digest(path));
        Ok(text)
    }

    fn connection_upsert(&self, candidate_json: &str) -> Result<(), String> {
        self.require(PluginPermission::ConnectionsWrite)
            .map_err(|e| e.to_string())?;
        let candidate: omnipanel_plugin::ImportCandidate =
            serde_json::from_str(candidate_json).map_err(|e| format!("候选 JSON 非法: {e}"))?;
        if candidate.plugin_id != self.plugin_id {
            return Err("候选 pluginId 与当前插件不一致".into());
        }
        let rt = tokio::runtime::Handle::current();
        let storage = Arc::clone(&self.storage);
        let dedupe = candidate.dedupe_key().0;
        rt.block_on(async move {
            let store = storage.lock().await;
            save_candidate(&store, &candidate)
        })
        .map_err(|e| e.to_string())?;
        self.audit("plugin.upsert", "success", dedupe);
        Ok(())
    }

    fn invoke(&self, method: &str, args_json: &str) -> Result<String, String> {
        // 与 plugin_invoke 命令同源的白名单+权限强制
        let decl = {
            let rt = tokio::runtime::Handle::current();
            let registry = Arc::clone(&self.registry);
            let method = method.to_string();
            let pid = self.plugin_id.clone();
            rt.block_on(async move {
                let guard = registry.lock().await;
                guard.declared_method(&pid, &method)
            })
        }
        .map_err(|e| e.to_string())?;
        {
            let rt = tokio::runtime::Handle::current();
            let registry = Arc::clone(&self.registry);
            let pid = self.plugin_id.clone();
            let perms = decl.permissions.clone();
            rt.block_on(async move {
                let guard = registry.lock().await;
                for permission in perms {
                    guard.require_permission(&pid, permission)?;
                }
                Ok::<(), PluginError>(())
            })
        }
        .map_err(|e| e.to_string())?;
        let args: serde_json::Value = serde_json::from_str(args_json)
            .map_err(|e| format!("args 非法 JSON: {e}"))?;
        let gateway = Arc::clone(&self.gateway);
        let pid = self.plugin_id.clone();
        let method = method.to_string();
        let rt = tokio::runtime::Handle::current();
        let result: Result<serde_json::Value, PluginError> =
            rt.block_on(gateway.invoke(&pid, &method, args));
        result
            .map(|value| value.to_string())
            .map_err(|e: PluginError| e.to_string())
    }
}

/// 简易去点号归一化（std canonicalize 在 Windows 上产出 \\?\ 前缀且要求存在，
/// 对禁锢判断而言按词法处理足够）。
fn dedot(path: &PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 把 ImportCandidate 写入统一连接存储（与前端 upsertCandidateConnection
/// 同语义的最小后端版：ssh / panel / docker / database 四类）。
fn save_candidate(
    store: &Storage,
    candidate: &omnipanel_plugin::ImportCandidate,
) -> Result<(), omnipanel_error::OmniError> {
    use omnipanel_plugin::ImportCandidate as C;
    use omnipanel_store::{Connection, ConnectionKind};

    let cfg = candidate.config.as_object().cloned().unwrap_or_default();
    let str_field = |key: &str| {
        cfg.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let num_field = |key: &str, default: i64| {
        cfg.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let remote_kind = candidate.remote_kind.as_str();
    let kind = match remote_kind {
        "ssh" => ConnectionKind::Ssh,
        "panel" => ConnectionKind::Panel,
        "docker" => ConnectionKind::Docker,
        "mysql" | "postgres" | "postgresql" | "clickhouse" | "qdrant" | "redis" => {
            ConnectionKind::Database
        }
        "cloud" => ConnectionKind::Cloud,
        other => {
            return Err(omnipanel_error::OmniError::invalid_input(format!(
                "不支持的导入类型: {other}"
            )))
        }
    };

    let config_value = match kind {
        ConnectionKind::Database => serde_json::json!({
            "host": str_field("host"),
            "port": num_field("port", if remote_kind == "postgres" || remote_kind == "postgresql" { 5432 } else { 3306 }),
            "user": str_field("user"),
            "password": str_field("password"),
            "database": str_field("database"),
            "db_type": remote_kind,
        }),
        _ => serde_json::json!({
            "host": str_field("host"),
            "port": num_field("port", 22),
            "user": str_field("user"),
            "address": str_field("address"),
            "serviceType": if str_field("serviceType").is_empty() { candidate.plugin_id.clone() } else { str_field("serviceType") },
            "sshConnectionId": str_field("sshConnectionId"),
            "externalSource": {
                "pluginId": candidate.plugin_id,
                "accountId": candidate.account_id,
                "remoteId": candidate.remote_id,
                "remoteKind": candidate.remote_kind,
            },
        }),
    };

    let conn = Connection {
        id: String::new(),
        kind,
        name: candidate.name.clone(),
        group: "插件导入".into(),
        env_tag: "unknown".into(),
        tags: vec![],
        config: config_value.to_string(),
        credential_ref: None,
        created_at: now,
        updated_at: now,
    };
    store.save_connection(&conn)
}
