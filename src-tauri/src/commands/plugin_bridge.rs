//! 桌面壳：prod 确认器与 SSH 回调。权限闸在 `omnipanel-plugin-host`。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use omnipanel_plugin::{ConfirmFuture, ConfirmRequest, ProdConfirmer};
use omnipanel_plugin_host::{SshExec, block_on_detached};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub use omnipanel_plugin_host::PluginBridge;

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
    pub pending: Arc<tokio::sync::Mutex<HashMap<String, PendingPluginConfirm>>>,
}

pub struct PendingPluginConfirm {
    pub tx: tokio::sync::oneshot::Sender<bool>,
    pub grant_target: String,
}

impl ProdConfirmer for TauriProdConfirmer {
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
        let app = self.app.clone();
        let rid = request_id.clone();
        Box::pin(async move {
            {
                let mut guard = pending.lock().await;
                guard.insert(rid.clone(), PendingPluginConfirm { tx, grant_target });
            }
            let _ = app.emit(PLUGIN_CONFIRM_REQUEST_EVENT, &payload);
            let allowed = wait_confirm(rx, CONFIRM_TIMEOUT).await;
            let _ = pending.lock().await.remove(&rid);
            Ok(allowed)
        })
    }
}

/// 仅明确同意才放行；超时、通道关闭、用户拒绝一律 false。
async fn wait_confirm(rx: tokio::sync::oneshot::Receiver<bool>, timeout: Duration) -> bool {
    matches!(tokio::time::timeout(timeout, rx).await, Ok(Ok(true)))
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

/// 桌面 SSH：走连接池 exec channel。连接 id 由宿主桥决定，这里只执行。
pub struct TauriSshExec {
    pub pool: Arc<crate::background::SshPool>,
}

impl SshExec for TauriSshExec {
    fn exec(
        &self,
        connection_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let pool = Arc::clone(&self.pool);
        let connection_id = connection_id.to_string();
        let command = command.to_string();
        block_on_detached(async move {
            let session = pool
                .ensure_session(&connection_id)
                .await
                .map_err(|err| err.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::wait_confirm;
    use std::time::Duration;

    #[tokio::test]
    async fn confirm_timeout_is_deny() {
        let (_tx, rx) = tokio::sync::oneshot::channel::<bool>();
        assert!(!wait_confirm(rx, Duration::from_millis(20)).await);
    }

    #[tokio::test]
    async fn confirm_cancel_is_deny() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(false).unwrap();
        assert!(!wait_confirm(rx, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn confirm_allow_is_true() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(true).unwrap();
        assert!(wait_confirm(rx, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn confirm_dropped_sender_is_deny() {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        drop(tx);
        assert!(!wait_confirm(rx, Duration::from_secs(1)).await);
    }
}
