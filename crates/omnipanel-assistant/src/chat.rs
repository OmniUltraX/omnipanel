//! 助手 → 客户端聊天收件：latest 索引 + OSS 对象解析。

use omnipanel_error::OmniResult;
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;

use crate::error::{map_assistant_error, map_assistant_error_with_cause, AssistantErrorKind};
use crate::sts::AuthContext;

/// `GET /api/assistant/chat/latest` 返回的索引（及 SSE `message` 的 data）。
///
/// 服务端 `userId` 为 int64，需兼容数字与字符串。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatLatestIndex {
    #[serde(
        default,
        alias = "user_id",
        deserialize_with = "deserialize_stringish"
    )]
    pub user_id: String,
    #[serde(alias = "object_key")]
    pub object_key: String,
    #[serde(default, alias = "oss_path")]
    pub oss_path: String,
    #[serde(default, alias = "message_id")]
    pub message_id: String,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
    #[serde(default, alias = "published_at")]
    pub published_at: String,
}

impl ChatLatestIndex {
    /// 去重键：优先 messageId，否则 objectKey。
    pub fn dedupe_key(&self) -> String {
        let mid = self.message_id.trim();
        if !mid.is_empty() {
            return mid.to_string();
        }
        self.object_key.trim().to_string()
    }
}

/// 接受 JSON string / number / null → String。
fn deserialize_stringish<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match v {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct LatestApiEnvelope {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    data: Option<ChatLatestIndex>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// `GET {api_base}/api/assistant/chat/latest`；无消息时返回 `None`。
pub async fn fetch_chat_latest(auth: &AuthContext) -> OmniResult<Option<ChatLatestIndex>> {
    let url = format!(
        "{}/api/assistant/chat/latest",
        auth.api_base.trim_end_matches('/')
    );
    let resp = auth
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Inbox,
                "读取聊天 latest 失败",
                e.to_string(),
            )
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Inbox,
            "读取聊天 latest 响应失败",
            e.to_string(),
        )
    })?;

    if status.as_u16() == 204 || text.trim().is_empty() {
        return Ok(None);
    }
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(map_assistant_error(
            AssistantErrorKind::Inbox,
            format!("读取聊天 latest 失败 (HTTP {}): {text}", status.as_u16()),
        ));
    }

    if let Ok(env) = serde_json::from_str::<LatestApiEnvelope>(&text) {
        // 服务端固定 `{ status, data }`；data 可为 null
        if env.status.is_some() || env.data.is_some() || text.contains("\"data\"") {
            if env.data.is_none() {
                if let Some(err) = env.error.or(env.message) {
                    if env.status.as_deref() != Some("ok") {
                        return Err(map_assistant_error(AssistantErrorKind::Inbox, err));
                    }
                }
                return Ok(None);
            }
            return Ok(env
                .data
                .filter(|d| !d.object_key.trim().is_empty()));
        }
        if let Some(err) = env.error.or(env.message) {
            return Err(map_assistant_error(AssistantErrorKind::Inbox, err));
        }
    }

    let index: ChatLatestIndex = serde_json::from_str(&text).map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Inbox,
            "解析聊天 latest 失败",
            format!("{e}; body={text}"),
        )
    })?;
    if index.object_key.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(index))
}

/// 从 OSS 正文解析出可展示的助手消息文本。
pub fn extract_inbound_message_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        for key in ["text", "content", "message", "body"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
        if let Some(parts) = v.get("parts").and_then(|x| x.as_array()) {
            let mut out = String::new();
            for p in parts {
                let t = p.get("t").or_else(|| p.get("type")).and_then(|x| x.as_str());
                let text = p.get("text").and_then(|x| x.as_str()).unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                if matches!(t, Some("content") | Some("text") | None) {
                    out.push_str(text);
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }
    // omni-chat-sections.v1：优先取 user_message / ai___message 段正文
    if trimmed.contains("|[") && trimmed.contains("]|") {
        if let Some(text) = extract_section_bodies(trimmed) {
            return text;
        }
    }
    // 旧 NDJSON：拼接 content / text 行
    if trimmed.lines().any(|l| l.trim_start().starts_with('{')) {
        let mut out = String::new();
        for line in trimmed.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let t = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
                // 助手→客户端：只拼正文，忽略 user / reasoning / tool_*
                if matches!(t, "content" | "text" | "") {
                    if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                        out.push_str(text);
                    }
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    trimmed.to_string()
}

/// 解析 `----------------\n|[tag]|\n----------------\nbody` 段落。
fn extract_section_bodies(raw: &str) -> Option<String> {
    let mut preferred = String::new();
    let mut fallback = String::new();
    let lines: Vec<&str> = raw.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if line != "----------------" {
            i += 1;
            continue;
        }
        if i + 2 >= lines.len() {
            break;
        }
        let tag_line = lines[i + 1].trim();
        let close = lines[i + 2].trim();
        if close != "----------------" {
            i += 1;
            continue;
        }
        let Some(tag) = parse_section_tag(tag_line) else {
            i += 1;
            continue;
        };
        i += 3;
        let mut body = String::new();
        while i < lines.len() {
            let peek = lines[i].trim();
            if peek == "----------------" {
                break;
            }
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(lines[i]);
            i += 1;
        }
        let body = body.trim().to_string();
        if body.is_empty() {
            continue;
        }
        // 入站展示：优先用户可见消息段，其次任意纯文本段
        if matches!(tag.as_str(), "user_message" | "ai___message") {
            if !preferred.is_empty() {
                preferred.push('\n');
            }
            preferred.push_str(&body);
        } else if !matches!(
            tag.as_str(),
            "tool_calling" | "tool___result" | "ai_reasoning" | "error______"
        ) {
            if !fallback.is_empty() {
                fallback.push('\n');
            }
            fallback.push_str(&body);
        }
    }
    if !preferred.is_empty() {
        Some(preferred)
    } else if !fallback.is_empty() {
        Some(fallback)
    } else {
        None
    }
}

fn parse_section_tag(line: &str) -> Option<String> {
    let line = line.trim();
    let rest = line.strip_prefix("|[")?;
    let tag = rest.strip_suffix("]|")?;
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_text_field() {
        assert_eq!(
            extract_inbound_message_text(r#"{"text":"hello"}"#),
            "hello"
        );
        assert_eq!(
            extract_inbound_message_text(r#"{"content":"world"}"#),
            "world"
        );
        assert_eq!(
            extract_inbound_message_text(r#"{"message":"from-assistant"}"#),
            "from-assistant"
        );
    }

    #[test]
    fn extract_ndjson_content_lines() {
        let raw = r#"# format=omni-chat-events.v1
{"v":1,"t":"content","text":"A"}
{"v":1,"t":"reasoning","text":"skip"}
{"v":1,"t":"content","text":"B"}
"#;
        assert_eq!(extract_inbound_message_text(raw), "AB");
    }

    #[test]
    fn extract_section_format_prefers_message_bodies() {
        let raw = r#"# format=omni-chat-sections.v1

----------------
|[user_message]|
----------------
来自助手端

----------------
|[ai_reasoning]|
----------------
跳过思考

----------------
|[ai___message]|
----------------
回复正文
"#;
        assert_eq!(
            extract_inbound_message_text(raw),
            "来自助手端\n回复正文"
        );
    }

    #[test]
    fn latest_index_accepts_snake_case() {
        let raw = r#"{
          "user_id":"u1",
          "object_key":"agent_chat_message/u1/msg-001.json",
          "oss_path":"agent_chat_message/u1/",
          "message_id":"msg-001",
          "created_at":"2026-07-27T10:00:00Z",
          "published_at":"2026-07-27T10:00:01Z"
        }"#;
        let index: ChatLatestIndex = serde_json::from_str(raw).unwrap();
        assert_eq!(index.object_key, "agent_chat_message/u1/msg-001.json");
        assert_eq!(index.message_id, "msg-001");
    }

    #[test]
    fn latest_index_accepts_numeric_user_id() {
        // 与 omniserver store.ChatMessageUpdate 一致：userId 为 int64
        let raw = r#"{
          "userId":42,
          "objectKey":"agent_chat_message/u1/msg-001.json",
          "ossPath":"omniminiapp/agent_chat_message/u1/",
          "messageId":"msg-001",
          "createdAt":"2026-07-27T10:00:00Z",
          "publishedAt":"2026-07-27T10:00:01Z",
          "assistantAppId":"omni-assistant",
          "assistantDeviceId":"dev-1"
        }"#;
        let index: ChatLatestIndex = serde_json::from_str(raw).unwrap();
        assert_eq!(index.user_id, "42");
        assert_eq!(index.object_key, "agent_chat_message/u1/msg-001.json");
        assert_eq!(index.dedupe_key(), "msg-001");
    }

    #[test]
    fn latest_envelope_null_data() {
        let raw = r#"{"status":"ok","data":null}"#;
        let env: LatestApiEnvelope = serde_json::from_str(raw).unwrap();
        assert!(env.data.is_none());
        assert_eq!(env.status.as_deref(), Some("ok"));
    }
}
