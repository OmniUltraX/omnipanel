//! 助手 → 客户端聊天收件：latest 索引 + OSS 对象解析。

use omnipanel_error::OmniResult;
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;

use crate::sts::AuthContext;

/// `GET /api/assistant/chat/latest` 返回的索引（及 SSE `message` 的 data）。
///
/// 服务端 `userId` 为 int64，需兼容数字与字符串（见 `ChatLatestIndexRaw`）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatLatestIndex {
    #[serde(default, alias = "user_id")]
    pub user_id: String,
    #[serde(alias = "object_key")]
    pub object_key: String,
    #[serde(default, alias = "oss_path")]
    pub oss_path: String,
    #[serde(default, alias = "message_id")]
    pub message_id: String,
    /// 目标 AI 会话 id（助手端当前选中；客户端按此投递）。
    #[serde(default, alias = "session_id")]
    pub session_id: String,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
    #[serde(default, alias = "published_at")]
    pub published_at: String,
}

/// JSON 反序列化用：`userId` 兼容 number/string，避免 specta 导出 `deserialize_with`。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatLatestIndexRaw {
    #[serde(default, alias = "user_id", deserialize_with = "deserialize_stringish")]
    user_id: String,
    #[serde(alias = "object_key")]
    object_key: String,
    #[serde(default, alias = "oss_path")]
    oss_path: String,
    #[serde(default, alias = "message_id")]
    message_id: String,
    #[serde(default, alias = "session_id")]
    session_id: String,
    #[serde(default, alias = "created_at")]
    created_at: String,
    #[serde(default, alias = "published_at")]
    published_at: String,
}

impl From<ChatLatestIndexRaw> for ChatLatestIndex {
    fn from(raw: ChatLatestIndexRaw) -> Self {
        Self {
            user_id: raw.user_id,
            object_key: raw.object_key,
            oss_path: raw.oss_path,
            message_id: raw.message_id,
            session_id: raw.session_id,
            created_at: raw.created_at,
            published_at: raw.published_at,
        }
    }
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

    /// 解析 JSON（`userId` 兼容 number/string）。
    pub fn parse_json(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str::<ChatLatestIndexRaw>(raw).map(Self::from)
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

/// `GET /api/assistant/chat/latest` 已废弃；改由 `/api/notify/wait` 连接时推送最近一条。
/// 保留函数签名以免破坏 bindings；始终返回 `None`。
pub async fn fetch_chat_latest(_auth: &AuthContext) -> OmniResult<Option<ChatLatestIndex>> {
    Ok(None)
}

/// 从通用 notify SSE `notify` 事件解析聊天索引。
pub fn chat_index_from_notify_json(raw: &str) -> Result<ChatLatestIndex, serde_json::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        #[serde(default)]
        event: String,
        #[serde(default)]
        user_id: serde_json::Value,
        #[serde(default)]
        published_at: String,
        #[serde(default)]
        payload: serde_json::Value,
    }
    let env: Envelope = serde_json::from_str(raw)?;
    // 也兼容旧版直接推 ChatLatestIndex
    if env.event.is_empty() && env.payload.is_null() {
        return ChatLatestIndex::parse_json(raw);
    }
    let p = &env.payload;
    let object_key = p
        .get("objectKey")
        .or_else(|| p.get("object_key"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let message_id = p
        .get("messageId")
        .or_else(|| p.get("message_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let session_id = p
        .get("sessionId")
        .or_else(|| p.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let created_at = p
        .get("createdAt")
        .or_else(|| p.get("created_at"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let oss_path = p
        .get("ossPath")
        .or_else(|| p.get("oss_path"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_id = match &env.user_id {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    Ok(ChatLatestIndex {
        user_id,
        object_key,
        oss_path,
        message_id,
        session_id,
        created_at,
        published_at: env.published_at,
    })
}

/// 助手端切模通知（无 OSS；payload 内直接带 sessionId / modelSelectionId）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSetModelNotify {
    pub session_id: String,
    pub model_selection_id: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub published_at: String,
}

/// 从通用 notify SSE 解析 `assistant.chat.setModel`。
pub fn set_model_from_notify_json(raw: &str) -> Result<ChatSetModelNotify, serde_json::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        #[serde(default)]
        event: String,
        #[serde(default)]
        published_at: String,
        #[serde(default)]
        payload: serde_json::Value,
    }
    let env: Envelope = serde_json::from_str(raw)?;
    let event = env.event.trim();
    if event != "assistant.chat.setModel" {
        return Err(serde::de::Error::custom(format!(
            "unexpected event: {event}"
        )));
    }
    let p = &env.payload;
    let session_id = p
        .get("sessionId")
        .or_else(|| p.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let model_selection_id = p
        .get("modelSelectionId")
        .or_else(|| p.get("model_selection_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut provider_id = p
        .get("providerId")
        .or_else(|| p.get("provider_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut model_name = p
        .get("modelName")
        .or_else(|| p.get("model_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if (provider_id.is_empty() || model_name.is_empty()) && !model_selection_id.is_empty() {
        if let Some((pid, mname)) = model_selection_id.split_once("::") {
            if provider_id.is_empty() {
                provider_id = pid.trim().to_string();
            }
            if model_name.is_empty() {
                model_name = mname.trim().to_string();
            }
        }
    }
    Ok(ChatSetModelNotify {
        session_id,
        model_selection_id,
        provider_id,
        model_name,
        published_at: env.published_at,
    })
}

/// 从 OSS 正文解析出可展示的助手消息文本。
pub fn extract_inbound_message_text(raw: &str) -> String {
    parse_inbound_chat_message(raw).text
}

/// 助手端上行消息解析结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InboundChatContextItem {
    pub kind: String,
    pub id: String,
    pub label: String,
}

/// 助手端回传的澄清表单答案（快通道，不进普通聊天正文）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InboundAskUserAnswer {
    pub form_id: String,
    pub tool_call_id: String,
    /// `answered` | `skipped`
    pub status: String,
    /// answers 对象的 JSON 字符串（answered 时）；跳过可为 `{}`
    pub answers_json: String,
}

/// 助手端上行消息解析结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InboundChatMessage {
    pub text: String,
    pub session_id: String,
    pub contexts: Vec<InboundChatContextItem>,
    pub ask_user: Option<InboundAskUserAnswer>,
}

/// 解析助手端写入的消息 JSON（text + session_id + contexts）；兼容纯文本与 sections。
pub fn parse_inbound_chat_message(raw: &str) -> InboundChatMessage {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return InboundChatMessage::default();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let session_id = v
            .get("session_id")
            .or_else(|| v.get("sessionId"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let contexts = parse_contexts_value(v.get("contexts"));
        let ask_user = parse_ask_user_answer(&v);

        // 澄清答案优先：即使没有 text 也直接返回
        if ask_user.is_some() {
            let text = ["text", "content", "message", "body"]
                .iter()
                .find_map(|key| v.get(*key).and_then(|x| x.as_str()))
                .unwrap_or("")
                .to_string();
            return InboundChatMessage {
                text,
                session_id,
                contexts,
                ask_user,
            };
        }

        for key in ["text", "content", "message", "body"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    return InboundChatMessage {
                        text: s.to_string(),
                        session_id,
                        contexts,
                        ask_user: None,
                    };
                }
            }
        }
        if let Some(parts) = v.get("parts").and_then(|x| x.as_array()) {
            let mut out = String::new();
            for p in parts {
                let t = p
                    .get("t")
                    .or_else(|| p.get("type"))
                    .and_then(|x| x.as_str());
                let text = p.get("text").and_then(|x| x.as_str()).unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                if matches!(t, Some("content") | Some("text") | None) {
                    out.push_str(text);
                }
            }
            if !out.is_empty() {
                return InboundChatMessage {
                    text: out,
                    session_id,
                    contexts,
                    ask_user: None,
                };
            }
        }
        if !session_id.is_empty() {
            // 有 session 但无正文时，继续走 sections / 原文分支
        }
    }
    // omni-chat-sections.v1：优先取 user_message / ai___message 段正文
    if trimmed.contains("|[") && trimmed.contains("]|") {
        if let Some(text) = extract_section_bodies(trimmed) {
            return InboundChatMessage {
                text,
                session_id: String::new(),
                contexts: Vec::new(),
                ask_user: None,
            };
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
            return InboundChatMessage {
                text: out,
                session_id: String::new(),
                contexts: Vec::new(),
                ask_user: None,
            };
        }
    }
    InboundChatMessage {
        text: trimmed.to_string(),
        session_id: String::new(),
        contexts: Vec::new(),
        ask_user: None,
    }
}

fn parse_contexts_value(raw: Option<&serde_json::Value>) -> Vec<InboundChatContextItem> {
    let Some(arr) = raw.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in arr {
        let kind = item
            .get("kind")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if kind.is_empty() || id.is_empty() {
            continue;
        }
        let key = format!("{kind}:{id}");
        if !seen.insert(key) {
            continue;
        }
        let label = item
            .get("label")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        out.push(InboundChatContextItem {
            kind,
            id: id.clone(),
            label: if label.is_empty() {
                id
            } else {
                label.to_string()
            },
        });
    }
    out
}

/// 解析 `type=ask_user_answer` + `ask_user` 对象。
fn parse_ask_user_answer(v: &serde_json::Value) -> Option<InboundAskUserAnswer> {
    let type_hint = v
        .get("type")
        .or_else(|| v.get("kind"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    let ask = v.get("ask_user").or_else(|| v.get("askUser"))?;
    if !ask.is_object() {
        return None;
    }
    // type 缺失时仍允许：有完整 ask_user 对象即可（兼容旧草稿）
    if !type_hint.is_empty() && type_hint != "ask_user_answer" {
        return None;
    }
    let form_id = ask
        .get("formId")
        .or_else(|| ask.get("form_id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let tool_call_id = ask
        .get("toolCallId")
        .or_else(|| ask.get("tool_call_id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let status = ask
        .get("status")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if form_id.is_empty() || tool_call_id.is_empty() {
        return None;
    }
    if status != "answered" && status != "skipped" {
        return None;
    }
    let answers_json = match ask.get("answers") {
        Some(a) => a.to_string(),
        None => "{}".to_string(),
    };
    Some(InboundAskUserAnswer {
        form_id,
        tool_call_id,
        status,
        answers_json,
    })
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
            "tool_calling"
                | "tool___result"
                | "ai_reasoning"
                | "error______"
                | "plan________"
                | "ask_user____"
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
        assert_eq!(extract_inbound_message_text(r#"{"text":"hello"}"#), "hello");
        assert_eq!(
            extract_inbound_message_text(r#"{"content":"world"}"#),
            "world"
        );
        assert_eq!(
            extract_inbound_message_text(r#"{"message":"from-assistant"}"#),
            "from-assistant"
        );
        assert_eq!(
            parse_inbound_chat_message(
                r#"{"text":"hello","session_id":"conv_1","message_id":"msg-1"}"#
            ),
            InboundChatMessage {
                text: "hello".into(),
                session_id: "conv_1".into(),
                contexts: Vec::new(),
                ask_user: None,
            }
        );
        assert_eq!(
            parse_inbound_chat_message(r#"{"text":"hi","sessionId":"conv_2"}"#).session_id,
            "conv_2"
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
        assert_eq!(extract_inbound_message_text(raw), "来自助手端\n回复正文");
    }

    #[test]
    fn parse_ask_user_answer_without_text() {
        let raw = r#"{
          "message_id":"msg-ask-1",
          "session_id":"conv_ask",
          "type":"ask_user_answer",
          "ask_user":{
            "formId":"ask_1",
            "toolCallId":"tc_1",
            "status":"answered",
            "answers":{"q1":"prod"}
          }
        }"#;
        let parsed = parse_inbound_chat_message(raw);
        assert_eq!(parsed.session_id, "conv_ask");
        assert!(parsed.text.is_empty());
        let ask = parsed.ask_user.expect("ask_user");
        assert_eq!(ask.form_id, "ask_1");
        assert_eq!(ask.tool_call_id, "tc_1");
        assert_eq!(ask.status, "answered");
        assert!(ask.answers_json.contains("prod"));
    }

    #[test]
    fn parse_ask_user_skip() {
        let raw = r#"{
          "session_id":"conv_ask",
          "type":"ask_user_answer",
          "ask_user":{
            "form_id":"ask_2",
            "tool_call_id":"tc_2",
            "status":"skipped"
          }
        }"#;
        let ask = parse_inbound_chat_message(raw).ask_user.expect("ask_user");
        assert_eq!(ask.status, "skipped");
        assert_eq!(ask.form_id, "ask_2");
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
        let index = ChatLatestIndex::from(serde_json::from_str::<ChatLatestIndexRaw>(raw).unwrap());
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
        let index = ChatLatestIndex::from(serde_json::from_str::<ChatLatestIndexRaw>(raw).unwrap());
        assert_eq!(index.user_id, "42");
        assert_eq!(index.object_key, "agent_chat_message/u1/msg-001.json");
        assert_eq!(index.dedupe_key(), "msg-001");
    }

    #[test]
    fn latest_envelope_null_data() {
        #[derive(Debug, Deserialize)]
        struct LatestApiEnvelope {
            #[serde(default)]
            status: Option<String>,
            #[serde(default)]
            data: Option<ChatLatestIndexRaw>,
        }
        let raw = r#"{"status":"ok","data":null}"#;
        let env: LatestApiEnvelope = serde_json::from_str(raw).unwrap();
        assert!(env.data.is_none());
        assert_eq!(env.status.as_deref(), Some("ok"));
    }
}
