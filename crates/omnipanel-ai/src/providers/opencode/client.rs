use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::service::OpenCodeEndpoint;

#[derive(Debug, Clone)]
pub struct OpenCodeModel {
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    /// `limit.context`（上下文窗口）；未知则为 None
    pub context_limit: Option<u32>,
}

/// OpenCode 消息 / 步骤上的 token 用量（与官方 Session Context 一致）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTokenUsage {
    pub input: u32,
    pub output: u32,
    #[serde(default)]
    pub reasoning: u32,
    #[serde(default)]
    pub cache_read: u32,
    #[serde(default)]
    pub cache_write: u32,
    /// OpenCode 偶发直接给 `tokens.total`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
}

impl OpenCodeTokenUsage {
    /// 与 OpenCode `getSessionContext` / `tokenTotal` 对齐。
    pub fn context_total(&self) -> u32 {
        if let Some(t) = self.total {
            if t > 0 {
                return t;
            }
        }
        self.input
            .saturating_add(self.output)
            .saturating_add(self.reasoning)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    pub fn is_empty(&self) -> bool {
        self.context_total() == 0
    }
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

/// OpenCode 工具调用（历史消息 / DTO 共用）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// `pending` | `running` | `completed` | `failed`
    pub status: String,
}

/// 有序消息片段（保留 reasoning / text / tool 交错顺序，供前端 parts 渲染）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpenCodeMessagePart {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    #[serde(rename = "tool-call")]
    ToolCall {
        id: String,
        name: String,
        arguments: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        status: String,
    },
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
    /// 有序片段；缺省时前端用扁平字段 migrate。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<OpenCodeMessagePart>>,
    /// 从 parts 派生的工具调用列表（兼容扁平字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<OpenCodeToolCall>>,
    pub created_at: i64,
    /// assistant 消息上的 tokens（OpenCode 上下文用量事实源）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<OpenCodeTokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// 该消息模型的 `limit.context`（拉历史时解析）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u32>,
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
        format!("{}{}", self.endpoint.base_url.trim_end_matches('/'), path)
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
        struct ModelLimit {
            #[serde(default)]
            context: u64,
        }
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
            #[serde(default)]
            limit: Option<ModelLimit>,
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
                let context_limit = row
                    .limit
                    .and_then(|l| {
                        if l.context > 0 && l.context <= u32::MAX as u64 {
                            Some(l.context as u32)
                        } else {
                            None
                        }
                    });
                Some(OpenCodeModel {
                    provider_id,
                    model_id,
                    name,
                    context_limit,
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

        // 补齐模型 context limit（OpenCode Session Context 用量环分母）
        if out.iter().any(|m| {
            m.tokens.as_ref().is_some_and(|t| !t.is_empty())
                && m.provider_id.is_some()
                && m.model_id.is_some()
        }) {
            if let Ok(models) = self.list_models().await {
                let limits: std::collections::HashMap<(String, String), u32> = models
                    .into_iter()
                    .filter_map(|m| {
                        m.context_limit
                            .map(|lim| ((m.provider_id, m.model_id), lim))
                    })
                    .collect();
                for msg in &mut out {
                    if msg.context_limit.is_some() {
                        continue;
                    }
                    let (Some(pid), Some(mid)) = (&msg.provider_id, &msg.model_id) else {
                        continue;
                    };
                    if let Some(lim) = limits.get(&(pid.clone(), mid.clone())) {
                        msg.context_limit = Some(*lim);
                    }
                }
            }
        }

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
        // 宽松解析：OpenCode 可能加字段；缺 id 的条目跳过，避免整表失败 → 前端下拉空白。
        #[derive(Deserialize)]
        struct Envelope {
            data: Vec<serde_json::Value>,
        }

        let env: Envelope = self.get_json("/api/agent").await?;
        Ok(env
            .data
            .into_iter()
            .filter_map(|row| {
                let id = row
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if id.is_empty() {
                    return None;
                }
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(id.as_str())
                    .to_string();
                let description = row
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let mode = row
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("all")
                    .to_string();
                let hidden = row
                    .get("hidden")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let color = row
                    .get("color")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                Some(OpenCodeAgentInfo {
                    id,
                    name,
                    description,
                    mode,
                    hidden,
                    color,
                })
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
        let env: Envelope = self.get_json(&format!("/api/agent/{encoded}")).await?;
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
    /// `agent` 可为 id（`build`）或显示名（`Build`）；写入前归一为 id。
    pub async fn switch_session_agent(&self, session_id: &str, agent: &str) -> Result<(), String> {
        let agent_id = self.resolve_agent_id(agent).await?;
        let body = json!({ "agent": agent_id });
        self.post_empty(&format!("/api/session/{session_id}/agent"), &body)
            .await
    }

    /// 将 id / 显示名归一为 OpenCode agent id（查找区分大小写的 id）。
    pub async fn resolve_agent_id(&self, agent: &str) -> Result<String, String> {
        let raw = agent.trim();
        if raw.is_empty() {
            return Err("OpenCode agent 为空".to_string());
        }
        let agents = self.list_agents().await?;
        if let Some(hit) = agents.iter().find(|a| a.id == raw) {
            return Ok(hit.id.clone());
        }
        let lower = raw.to_ascii_lowercase();
        if let Some(hit) = agents.iter().find(|a| a.id.eq_ignore_ascii_case(&lower)) {
            return Ok(hit.id.clone());
        }
        if let Some(hit) = agents
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(raw) || a.name == raw)
        {
            return Ok(hit.id.clone());
        }
        Err(format!(
            "OpenCode Agent 未找到: \"{raw}\" (可用: {})",
            agents
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    /// 读取会话当前 agent 字段（可能是历史写入的显示名）。
    pub async fn get_session_agent(&self, session_id: &str) -> Result<Option<String>, String> {
        #[derive(Deserialize)]
        struct Envelope {
            data: SessionAgentRow,
        }
        #[derive(Deserialize)]
        struct SessionAgentRow {
            #[serde(default)]
            agent: Option<String>,
        }
        let env: Envelope = self.get_json(&format!("/api/session/{session_id}")).await?;
        Ok(env
            .data
            .agent
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()))
    }

    /// 若会话 agent 不是合法 id（常见：UI 曾写入显示名 `Build`），纠正为 id 后再 prompt。
    pub async fn ensure_session_agent_id(&self, session_id: &str) -> Result<String, String> {
        let current = self.get_session_agent(session_id).await?;
        let agents = self.list_agents().await?;
        let pick_fallback = || {
            agents
                .iter()
                .find(|a| !a.hidden && (a.mode == "primary" || a.mode == "all"))
                .or_else(|| agents.first())
                .map(|a| a.id.clone())
                .ok_or_else(|| "OpenCode 无可用 Agent".to_string())
        };

        let Some(cur) = current else {
            let id = pick_fallback()?;
            self.switch_session_agent(session_id, &id).await?;
            return Ok(id);
        };

        if agents.iter().any(|a| a.id == cur) {
            return Ok(cur);
        }

        // 显示名 / 大小写不符 → 归一；找不到则退回默认 primary
        let id = match self.resolve_agent_id(&cur).await {
            Ok(id) => id,
            Err(_) => pick_fallback()?,
        };
        if id != cur {
            self.switch_session_agent(session_id, &id).await?;
        }
        Ok(id)
    }

    /// 回复 OpenCode 澄清提问（`answers` 为每题选中的 **label** 列表）。
    pub async fn reply_question(
        &self,
        session_id: &str,
        request_id: &str,
        answers: &[Vec<String>],
    ) -> Result<(), String> {
        let body = json!({ "answers": answers });
        let session_path =
            format!("/api/session/{session_id}/question/{request_id}/reply");
        match self.post_empty(&session_path, &body).await {
            Ok(()) => Ok(()),
            Err(session_err) => {
                // 兼容旧路由：`POST /api/question/{requestID}/reply` 与无 /api 前缀
                match self
                    .post_empty(&format!("/api/question/{request_id}/reply"), &body)
                    .await
                {
                    Ok(()) => Ok(()),
                    Err(api_err) => match self
                        .post_empty(&format!("/question/{request_id}/reply"), &body)
                        .await
                    {
                        Ok(()) => Ok(()),
                        Err(legacy_err) => Err(format!(
                            "OpenCode question reply 失败: session={session_err}; /api/question={api_err}; /question={legacy_err}"
                        )),
                    },
                }
            }
        }
    }

    /// 拒绝 / 跳过 OpenCode 澄清提问。
    pub async fn reject_question(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<(), String> {
        let body = json!({});
        let session_path =
            format!("/api/session/{session_id}/question/{request_id}/reject");
        match self.post_empty(&session_path, &body).await {
            Ok(()) => Ok(()),
            Err(session_err) => match self
                .post_empty(&format!("/api/question/{request_id}/reject"), &body)
                .await
            {
                Ok(()) => Ok(()),
                Err(api_err) => match self
                    .post_empty(&format!("/question/{request_id}/reject"), &body)
                    .await
                {
                    Ok(()) => Ok(()),
                    Err(legacy_err) => Err(format!(
                        "OpenCode question reject 失败: session={session_err}; /api/question={api_err}; /question={legacy_err}"
                    )),
                },
            },
        }
    }

    /// 回复 OpenCode V2 Form（`answer` 为 field key → value）。
    pub async fn reply_form(
        &self,
        session_id: &str,
        form_id: &str,
        answer: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        let body = json!({ "answer": answer });
        self.post_empty(
            &format!("/api/session/{session_id}/form/{form_id}/reply"),
            &body,
        )
        .await
    }

    /// 取消 / 跳过 OpenCode V2 Form（`DELETE /api/session/{id}/form/{formID}`）。
    pub async fn cancel_form(&self, session_id: &str, form_id: &str) -> Result<(), String> {
        self.delete_empty(&format!("/api/session/{session_id}/form/{form_id}"))
            .await
    }

    /// 回复 OpenCode 权限请求（`decision`: once | always | reject）。
    pub async fn reply_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: &str,
    ) -> Result<(), String> {
        let decision = match decision {
            "once" | "always" | "reject" => decision,
            "allow_once" | "allow-once" | "allow" => "once",
            "allow_always" | "allow-always" => "always",
            "reject_once" | "reject-once" | "deny" => "reject",
            other => other,
        };
        let body = json!({ "decision": decision });
        self.post_empty(
            &format!("/api/session/{session_id}/permission/{request_id}/reply"),
            &body,
        )
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

    let (content, reasoning, parts, tool_calls) = if role == "user" {
        let text = row
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| extract_text_parts(message_parts_value(row)));
        let parts = if text.is_empty() {
            None
        } else {
            Some(vec![OpenCodeMessagePart::Text { text: text.clone() }])
        };
        (text, None, parts, None)
    } else {
        let content_val = message_parts_value(row);
        let parts = extract_ordered_parts(content_val);
        let content = parts
            .iter()
            .filter_map(|p| match p {
                OpenCodeMessagePart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        let reasoning = {
            let r = parts
                .iter()
                .filter_map(|p| match p {
                    OpenCodeMessagePart::Reasoning { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if r.trim().is_empty() {
                None
            } else {
                Some(r)
            }
        };
        let tool_calls: Vec<OpenCodeToolCall> = parts
            .iter()
            .filter_map(|p| match p {
                OpenCodeMessagePart::ToolCall {
                    id,
                    name,
                    arguments,
                    result,
                    status,
                } => Some(OpenCodeToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                    result: result.clone(),
                    status: status.clone(),
                }),
                _ => None,
            })
            .collect();
        let parts_opt = if parts.is_empty() { None } else { Some(parts) };
        let tools_opt = if tool_calls.is_empty() {
            None
        } else {
            Some(tool_calls)
        };
        (content, reasoning, parts_opt, tools_opt)
    };

    let tokens = if role == "assistant" {
        parse_opencode_tokens(row.get("tokens"))
    } else {
        None
    };
    let provider_id = row
        .get("providerID")
        .or_else(|| row.get("providerId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let model_id = row
        .get("modelID")
        .or_else(|| row.get("modelId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    Some(OpenCodeChatMessage {
        id,
        role: role.to_string(),
        content,
        reasoning,
        parts,
        tool_calls,
        created_at,
        tokens,
        provider_id,
        model_id,
        context_limit: None,
    })
}

fn parse_opencode_tokens(raw: Option<&serde_json::Value>) -> Option<OpenCodeTokenUsage> {
    let tokens = raw?;
    if !tokens.is_object() {
        return None;
    }
    let num = |key: &str| -> u32 {
        tokens
            .get(key)
            .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
            .unwrap_or(0) as u32
    };
    let cache = tokens.get("cache");
    let cache_read = cache
        .and_then(|c| c.get("read"))
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
        .unwrap_or(0) as u32;
    let cache_write = cache
        .and_then(|c| c.get("write"))
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
        .unwrap_or(0) as u32;
    let total = tokens
        .get("total")
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
        .map(|n| n as u32)
        .filter(|&n| n > 0);
    let usage = OpenCodeTokenUsage {
        input: num("input"),
        output: num("output"),
        reasoning: num("reasoning"),
        cache_read,
        cache_write,
        total,
    };
    if usage.is_empty() {
        None
    } else {
        Some(usage)
    }
}

/// OpenCode 历史可能挂在 `content` 或 `parts`。
fn message_parts_value(row: &serde_json::Value) -> Option<&serde_json::Value> {
    row.get("content")
        .filter(|v| v.is_array() || v.is_string())
        .or_else(|| row.get("parts").filter(|v| v.is_array()))
}

fn extract_text_parts(content: Option<&serde_json::Value>) -> String {
    let Some(arr) = content.and_then(|c| c.as_array()) else {
        return content.and_then(|c| c.as_str()).unwrap_or("").to_string();
    };
    arr.iter()
        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

fn extract_ordered_parts(content: Option<&serde_json::Value>) -> Vec<OpenCodeMessagePart> {
    let Some(arr) = content.and_then(|c| c.as_array()) else {
        if let Some(s) = content.and_then(|c| c.as_str()).filter(|s| !s.is_empty()) {
            return vec![OpenCodeMessagePart::Text {
                text: s.to_string(),
            }];
        }
        return Vec::new();
    };
    let mut out = Vec::new();
    for p in arr {
        let Some(ty) = p.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        match ty {
            "text" => {
                let text = p.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if !text.is_empty() {
                    out.push(OpenCodeMessagePart::Text {
                        text: text.to_string(),
                    });
                }
            }
            "reasoning" => {
                let text = p.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if !text.is_empty() {
                    out.push(OpenCodeMessagePart::Reasoning {
                        text: text.to_string(),
                    });
                }
            }
            "tool" => {
                if let Some(tc) = map_tool_part(p) {
                    out.push(OpenCodeMessagePart::ToolCall {
                        id: tc.id,
                        name: tc.name,
                        arguments: tc.arguments,
                        result: tc.result,
                        status: tc.status,
                    });
                }
            }
            "subtask" => {
                if let Some(tc) = map_subtask_part(p) {
                    out.push(OpenCodeMessagePart::ToolCall {
                        id: tc.id,
                        name: tc.name,
                        arguments: tc.arguments,
                        result: tc.result,
                        status: tc.status,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// 兼容运行态（`id`/`name`/`state.content[]`）与 SDK（`callID`/`tool`/`state.output`）。
fn map_tool_part(p: &serde_json::Value) -> Option<OpenCodeToolCall> {
    let id = p
        .get("id")
        .or_else(|| p.get("callID"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let name = p
        .get("name")
        .or_else(|| p.get("tool"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let state = p.get("state");
    let status = map_tool_status(state.and_then(|s| s.get("status")).and_then(|s| s.as_str()));
    let arguments = state
        .and_then(|s| s.get("input"))
        .map(|input| {
            if input.is_string() {
                input.as_str().unwrap_or("{}").to_string()
            } else {
                serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
            }
        })
        .or_else(|| {
            state
                .and_then(|s| s.get("raw"))
                .and_then(|r| r.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "{}".to_string());
    let result = state.and_then(extract_tool_result);
    Some(OpenCodeToolCall {
        id,
        name,
        arguments,
        result,
        status,
    })
}

/// 子智能体任务：映射为名为 `subtask` 的工具调用，便于前端统一渲染。
fn map_subtask_part(p: &serde_json::Value) -> Option<OpenCodeToolCall> {
    let id = p
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let agent = p
        .get("agent")
        .and_then(|v| v.as_str())
        .unwrap_or("subagent");
    let description = p
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let prompt = p.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    let arguments = serde_json::json!({
        "agent": agent,
        "description": description,
        "prompt": prompt,
    })
    .to_string();
    let result = if description.is_empty() {
        None
    } else {
        Some(description.to_string())
    };
    Some(OpenCodeToolCall {
        id,
        name: format!("subtask:{agent}"),
        arguments,
        result,
        status: "completed".to_string(),
    })
}

fn map_tool_status(raw: Option<&str>) -> String {
    match raw.unwrap_or("") {
        "pending" => "pending".to_string(),
        "running" => "running".to_string(),
        "completed" => "completed".to_string(),
        "error" => "failed".to_string(),
        _ => "completed".to_string(),
    }
}

fn extract_tool_result(state: &serde_json::Value) -> Option<String> {
    if let Some(out) = state.get("output").and_then(|v| v.as_str()) {
        if !out.is_empty() {
            return Some(out.to_string());
        }
    }
    if let Some(err) = state.get("error").and_then(|v| v.as_str()) {
        if !err.is_empty() {
            return Some(err.to_string());
        }
    }
    if let Some(arr) = state.get("content").and_then(|c| c.as_array()) {
        let text = arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text").and_then(|t| t.as_str())
                } else {
                    item.as_str()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
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

#[cfg(test)]
mod message_map_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_tool_with_content_array() {
        let row = json!({
            "id": "msg_1",
            "type": "assistant",
            "time": { "created": 1 },
            "content": [
                { "type": "reasoning", "text": "think" },
                {
                    "type": "tool",
                    "id": "call_1",
                    "name": "shell",
                    "state": {
                        "status": "completed",
                        "input": { "command": "ls" },
                        "content": [{ "type": "text", "text": "a.txt" }]
                    }
                },
                { "type": "text", "text": "done" }
            ]
        });
        let msg = map_opencode_message(&row).expect("mapped");
        assert_eq!(msg.content, "done");
        assert_eq!(msg.reasoning.as_deref(), Some("think"));
        let tools = msg.tool_calls.expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "call_1");
        assert_eq!(tools[0].name, "shell");
        assert_eq!(tools[0].status, "completed");
        assert_eq!(tools[0].result.as_deref(), Some("a.txt"));
        let parts = msg.parts.expect("parts");
        assert_eq!(parts.len(), 3);
        assert!(matches!(parts[0], OpenCodeMessagePart::Reasoning { .. }));
        assert!(matches!(parts[1], OpenCodeMessagePart::ToolCall { .. }));
        assert!(matches!(parts[2], OpenCodeMessagePart::Text { .. }));
    }

    #[test]
    fn extracts_subtask_as_tool_call() {
        let row = json!({
            "id": "msg_2",
            "type": "assistant",
            "time": { "created": 2 },
            "parts": [{
                "type": "subtask",
                "id": "prt_1",
                "agent": "explore",
                "description": "find files",
                "prompt": "look for config"
            }]
        });
        let msg = map_opencode_message(&row).expect("mapped");
        let tools = msg.tool_calls.expect("tools");
        assert_eq!(tools[0].name, "subtask:explore");
        assert!(tools[0].arguments.contains("look for config"));
    }
}
