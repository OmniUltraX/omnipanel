//! 助手摘要加密信封（`kind: assistant-payload`）。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sync_key_wrap::{encrypt_assistant_payload, WRAP_ALG};

pub const ASSISTANT_PAYLOAD_KIND: &str = "assistant-payload";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPayloadEnvelope {
    pub kind: String,
    pub scheme: String,
    pub bind_id: String,
    pub device_id: String,
    pub generated_at: String,
    pub wrapped: String,
}

fn now_rfc3339_millis() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 毫秒精度对展示足够；避免引入 chrono 依赖。
    format!("{secs}")
}

/// 组装内层明文 + X25519 包装，返回可上传 OSS 的 JSON 字节。
pub fn build_assistant_payload_envelope(
    modules: Value,
    device_id: &str,
    bind_id: &str,
    assistant_pubkey_b64: &str,
) -> OmniResult<Vec<u8>> {
    let device_id = device_id.trim();
    let bind_id = bind_id.trim();
    if device_id.is_empty() || bind_id.is_empty() {
        return Err(OmniError::invalid_input("device_id 或 bind_id 无效"));
    }
    let generated_at = now_rfc3339_millis();
    let inner = serde_json::json!({
        "version": 1,
        "deviceId": device_id,
        "bindId": bind_id,
        "generatedAt": generated_at,
        "modules": modules,
    });
    let body = serde_json::to_vec(&inner).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化助手摘要失败").with_cause(e.to_string())
    })?;
    let aad = format!("{ASSISTANT_PAYLOAD_KIND}:{bind_id}:{device_id}");
    let wrapped = encrypt_assistant_payload(&body, assistant_pubkey_b64, &aad)?;
    let envelope = AssistantPayloadEnvelope {
        kind: ASSISTANT_PAYLOAD_KIND.to_string(),
        scheme: WRAP_ALG.to_string(),
        bind_id: bind_id.to_string(),
        device_id: device_id.to_string(),
        generated_at,
        wrapped,
    };
    serde_json::to_vec(&envelope).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化助手摘要信封失败").with_cause(e.to_string())
    })
}
