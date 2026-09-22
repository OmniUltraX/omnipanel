use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::service::OpenCodeEndpoint;

#[derive(Debug, Clone)]
pub struct OpenCodeModel {
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
}

/// OpenCode 会话摘要（列表用）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeSessionInfo {
    pub id: String,
    pub title: String,
    /// 毫秒时间戳（OpenCode `time.updated` / `created`）
    pub updated_at: i64,
    pub directory: Option<String>,
}

/// 映射到前端 Thread 的简化消息。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeChatMessage {
    pub id: String,
    /// `user` | `assistant`
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub created_at: i64,
}

/// OpenCode Agent（`GET /api/agent`）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAgentInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `primary` | `subagent` | `all`
    pub mode: String,
    pub hidden: bool,
    pub color: Option<String>,
}

impl OpenCodeModel {
    /// 选择器 / 会话用的稳定键：`{providerID}/{modelID}`。
    pub fn selection_key(&self) -> String {
        format!("{}/{}", self.provider_id, self.model_id)
    }

    /// 发现结果写入缓存：`{selection_key}\u{1f}{displayName}`。
    pub fn cache_entry(&self) -> String {
        format!("{}\u{1f}{}", self.selection_key(), self.name)
    }

    /// 解析缓存条目 → (selection_key, display_name)。
    pub fn parse_cache_entry(raw: &str) -> (String, String) {
        match raw.split_once('\u{1f}') {
            Some((id, name)) => {
                let id = id.to_string();
                let name = name.trim();
                (
                    id.clone(),
                    if name.is_empty() {
                        id
                    } else {
                        name.to_string()
                    },
                )
            }
            None => (raw.to_string(), raw.to_string()),
        }
    }
}

fn http_client() -> Client {
    // 本机回环必须绕过系统代理（Clash 等会把 127.0.0.1:4096 变成 502）。
    Client::builder()
        .no_proxy()
        .tcp_nodelay(true)
        .pool_max_idle_per_host(4)
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// SSE 专用：HTTP/1.1 + 禁用压缩，避免压缩缓冲导致「攒齐再吐」。
fn sse_client() -> Client {
    Client::builder()
        .no_proxy()
        .http1_only()
        .tcp_nodelay(true)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap_or_else(|_| Client::new())
}

#[derive(Debug, Clone)]
pub struct OpenCodeClient {
    http: Client,
    sse: Client,
    endpoint: OpenCodeEndpoint,
}

impl OpenCodeClient {
    pub fn new(endpoint: OpenCodeEndpoint) -> Self {
        Self {
            http: http_client(),
            sse: sse_client(),
            endpoint,
        }
    }

    pub fn endpoint(&self) -> &OpenCodeEndpoint {
        &self.endpoint
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}{}",
            self.endpoint.base_url.trim_end_matches('/'),
            path
        )
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, String> {
        let resp = self
            .http
            .get(self.url(path))
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("OpenCode 请求失败 ({path}): {e}"))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("OpenCode 读响应失败 ({path}): {e}"))?;
        if !status.is_success() {
            return Err(format!("OpenCode {path} 返回 {status}: {body}"));
        }
        serde_json::from_str(&body).map_err(|e| format!("OpenCode {path} JSON 解析失败: {e}"))
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T, String> {
        let resp = self
            .http
            .post(self.url(path))
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(std::time::Duration::from_secs(60))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("OpenCode 请求失败 ({path}): {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("OpenCode 读响应失败 ({path}): {e}"))?;
        if !status.is_success() {
            return Err(format!("OpenCode {path} 返回 {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("OpenCode {path} JSON 解析失败: {e}"))
    }

    /// 轻量探活：`GET /api/session`（比 `/api/model` 轻，避免探活打爆模型列表）。
    pub async fn health_probe(&self) -> Result<(), String> {
        let url = self.url("/api/session");
        match self
            .http
            .get(&url)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                // 不读完整 body，避免大 session 列表拖慢探活
                drop(resp);
                if status.is_success() {
                    Ok(())
                } else {
                    Err(format!("HTTP {status} @ {url}"))
                }
            }
            Err(e) => Err(format!("请求失败 @ {url}: {e}")),
        }
    }

    /// 轻量探活：鉴权 + HTTP 是否可达。
    pub async fn health_ok(&self) -> bool {
        self.health_probe().await.is_ok()
    }

    pub async fn list_models(&self) -> Result<Vec<OpenCodeModel>, String> {
        #[derive(Deserialize)]
        struct ModelRow {
            #[serde(rename = "modelID", default)]
            model_id: String,
            #[serde(rename = "providerID", default)]
            provider_id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            id: String,
        }
        #[derive(Deserialize)]
        struct Envelope {
            data: Vec<ModelRow>,
        }

        let env: Envelope = self.get_json("/api/model").await?;
        Ok(env
            .data
            .into_iter()
            .filter_map(|row| {
                let model_id = if !row.model_id.is_empty() {
                    row.model_id
                } else {
                    row.id
                };
                let provider_id = row.provider_id;
                if provider_id.is_empty() || model_id.is_empty() {
                    return None;
                }
                let name = if row.name.is_empty() {
                    model_id.clone()
                } else {
                    row.name
                };
                Some(OpenCodeModel {
                    provider_id,
                    model_id,
                    name,
                })
            })
            .collect())
    }

    /// 新建会话；`model` 为 `(providerID, modelID)`。
    pub async fn create_session(
        &self,
        directory: &str,
        model: Option<(&str, &str)>,
    ) -> Result<OpenCodeSessionInfo, String> {
        #[derive(Deserialize)]
        struct SessionData {
            id: String,
            #[serde(default)]
            title: String,
            #[serde(default)]
            time: SessionTime,
        }
        #[derive(Deserialize)]
        struct Envelope {
            data: SessionData,
        }
        #[derive(Deserialize, Default)]
        struct SessionTime {
            #[serde(default)]
            updated: i64,
            #[serde(default)]
            created: i64,
        }

        let mut body = json!({ "directory": directory });
        if let Some((provider_id, model_id)) = model {
            body["model"] = json!({
                "providerID": provider_id,
                "id": model_id,
            });
        }

        let env: Envelope = self.post_json("/api/session", &body).await?;
        let id = env.data.id;
        let title = if env.data.title.trim().is_empty() {
            id.clone()
        } else {
            env.data.title
        };
        let updated_at = if env.data.time.updated > 0 {
            env.data.time.updated
        } else if env.data.time.created > 0 {
            env.data.time.created
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        };
        Ok(OpenCodeSessionInfo {
            id,
            title,
            updated_at,
            directory: if directory.is_empty() {
                None
            } else {
                Some(directory.to_string())
            },
        })
    }

    /// 列出 OpenCode 会话（按更新时间倒序由调用方处理亦可）。
    pub async fn list_sessions(&self) -> Result<Vec<OpenCodeSessionInfo>, String> {
        #[derive(Deserialize)]
        struct Envelope {
            data: Vec<SessionRow>,
        }
        #[derive(Deserialize)]
        struct SessionRow {
            id: String,
            #[serde(default)]
            title: String,
            #[serde(default)]
            time: SessionTime,
            #[serde(default)]
            location: SessionLocation,
        }
        #[derive(Deserialize, Default)]
        struct SessionTime {
            #[serde(default)]
            updated: i64,
            #[serde(default)]
            created: i64,
        }
        #[derive(Deserialize, Default)]
        struct SessionLocation {
            #[serde(default)]
            directory: String,
        }

        let env: Envelope = self.get_json("/api/session").await?;
        Ok(env
            .data
            .into_iter()
            .map(|row| {
                let updated_at = if row.time.updated > 0 {
                    row.time.updated
                } else {
                    row.time.created
                };
                let title = if row.title.trim().is_empty() {
                    row.id.clone()
                } else {
                    row.title
                };
                OpenCodeSessionInfo {
                    id: row.id,
                    title,
                    updated_at,
                    directory: if row.location.directory.is_empty() {
                        None
                    } else {
                        Some(row.location.directory)
                    },
                }
            })
            .collect())
    }

    /// 拉取会话消息历史（`GET /api/session/{id}/message`）。
    pub async fn get_session_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<OpenCodeChatMessage>, String> {
        #[derive(Deserialize)]
        struct Envelope {
            data: Vec<serde_json::Value>,
        }

        let path = format!("/api/session/{session_id}/message");
        let url = self.url(&path);
        let resp = self
            .http
            .get(&url)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("OpenCode 请求失败 ({path}): {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("OpenCode 读响应失败 ({path}): {e}"))?;
        if status.as_u16() == 404
            || text.contains("SessionNotFound")
            || text.contains("Session not found")
        {
            return Err(format!("SESSION_NOT_FOUND:{session_id}"));
        }
        if !status.is_success() {
            return Err(format!("OpenCode {path} 返回 {status}: {text}"));
        }
        let env: Envelope = serde_json::from_str(&text)
            .map_err(|e| format!("OpenCode {path} JSON 解析失败: {e}"))?;
        let mut out = Vec::new();
        for row in env.data {
            let Some(mapped) = map_opencode_message(&row) else {
                continue;
            };
            out.push(mapped);
        }
        // API 通常新→旧；UI 要旧→新
        out.reverse();
        Ok(out)
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<(), String> {
        self.delete_empty(&format!("/api/session/{session_id}"))
            .await
    }

    async fn delete_empty(&self, path: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(self.url(path))
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("OpenCode 请求失败 ({path}): {e}"))?;
        let status = resp.status();
        if status.is_success() || status.as_u16() == 204 {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        // 已不存在：幂等成功（清空 / 重复删 / serve 重启后幽灵 id）
        if status.as_u16() == 404
            || body.contains("SessionNotFound")
            || body.contains("Session not found")
        {
            return Ok(());
        }
        Err(format!("OpenCode {path} 返回 {status}: {body}"))
    }

    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(default)]
            #[allow(dead_code)]
            data: serde_json::Value,
        }
        let body = json!({ "text": text });
        let _: Envelope = self
            .post_json(&format!("/api/session/{session_id}/prompt"), &body)
            .await?;
        Ok(())
    }

    /// 列出已注册 Agent（`GET /api/agent`）。
    pub async fn list_agents(&self) -> Result<Vec<OpenCodeAgentInfo>, String> {
        #[derive(Deserialize)]
        struct Envelope {
            data: Vec<AgentRow>,
        }
        #[derive(Deserialize)]
        struct AgentRow {
            id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            mode: String,
            #[serde(default)]
            hidden: bool,
            #[serde(default)]
            color: Option<String>,
        }

        let env: Envelope = self.get_json("/api/agent").await?;
        Ok(env
            .data
            .into_iter()
            .map(|row| {
                let name = if row.name.trim().is_empty() {
                    row.id.clone()
                } else {
                    row.name
                };
                OpenCodeAgentInfo {
                    id: row.id,
                    name,
                    description: row.description.filter(|s| !s.trim().is_empty()),
                    mode: if row.mode.trim().is_empty() {
                        "all".into()
                    } else {
                        row.mode
                    },
                    hidden: row.hidden,
                    color: row.color.filter(|s| !s.trim().is_empty()),
                }
            })
            .collect())
    }

    /// 单个 Agent（`GET /api/agent/{agentID}`）。
    pub async fn get_agent(&self, agent_id: &str) -> Result<OpenCodeAgentInfo, String> {
        #[derive(Deserialize)]
        struct Envelope {
            data: AgentRow,
        }
        #[derive(Deserialize)]
        struct AgentRow {
            id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            mode: String,
            #[serde(default)]
            hidden: bool,
            #[serde(default)]
            color: Option<String>,
        }

        let encoded = urlencoding_lite(agent_id);
        let env: Envelope = self
            .get_json(&format!("/api/agent/{encoded}"))
            .await?;
        let row = env.data;
        let name = if row.name.trim().is_empty() {
            row.id.clone()
        } else {
            row.name
        };
        Ok(OpenCodeAgentInfo {
            id: row.id,
            name,
            description: row.description.filter(|s| !s.trim().is_empty()),
            mode: if row.mode.trim().is_empty() {
                "all".into()
            } else {
                row.mode
            },
            hidden: row.hidden,
            color: row.color.filter(|s| !s.trim().is_empty()),
        })
    }

    /// 切换会话后续回合使用的 Agent（`POST /api/session/{id}/agent`）。
    pub async fn switch_session_agent(
        &self,
        session_id: &str,
        agent: &str,
    ) -> Result<(), String> {
        let body = json!({ "agent": agent });
        self.post_empty(&format!("/api/session/{session_id}/agent"), &body)
            .await
    }

    async fn post_empty(&self, path: &str, body: &serde_json::Value) -> Result<(), String> {
        let resp = self
            .http
            .post(self.url(path))
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(std::time::Duration::from_secs(30))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("OpenCode 请求失败 ({path}): {e}"))?;
        let status = resp.status();
        if status.is_success() || status.as_u16() == 204 {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        Err(format!("OpenCode {path} 返回 {status}: {text}"))
    }

    /// 打开 `/api/event` SSE 字节流（调用方自行解析）。
    pub async fn open_event_stream(&self) -> Result<reqwest::Response, String> {
        self.sse
            .get(self.url("/api/event"))
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .header(reqwest::header::CONNECTION, "keep-alive")
            // 明确拒绝压缩，防止中间层/客户端解压缓冲
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|e| format!("OpenCode SSE 连接失败: {e}"))
    }
}

fn map_opencode_message(row: &serde_json::Value) -> Option<OpenCodeChatMessage> {
    let msg_type = row.get("type")?.as_str()?;
    let role = match msg_type {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let id = row
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let created_at = row
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    let (content, reasoning) = if role == "user" {
        let text = row
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| extract_text_parts(row.get("content")));
        (text, None)
    } else {
        let content_val = row.get("content");
        let text = extract_text_parts(content_val);
        let reasoning = extract_reasoning_parts(content_val);
        (text, reasoning)
    };

    Some(OpenCodeChatMessage {
        id,
        role: role.to_string(),
        content,
        reasoning,
        created_at,
    })
}

fn extract_text_parts(content: Option<&serde_json::Value>) -> String {
    let Some(arr) = content.and_then(|c| c.as_array()) else {
        return content
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
    };
    arr.iter()
        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

fn extract_reasoning_parts(content: Option<&serde_json::Value>) -> Option<String> {
    let arr = content?.as_array()?;
    let text = arr
        .iter()
        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("reasoning"))
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 路径段编码（Agent name 多为 ascii；非安全字符百分号编码）。
fn urlencoding_lite(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
