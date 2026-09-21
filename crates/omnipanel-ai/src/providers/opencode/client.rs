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

#[derive(Debug, Clone)]
pub struct OpenCodeClient {
    http: Client,
    endpoint: OpenCodeEndpoint,
}

impl OpenCodeClient {
    pub fn new(endpoint: OpenCodeEndpoint) -> Self {
        Self {
            http: Client::new(),
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

    pub async fn health_ok(&self) -> bool {
        self.list_models().await.is_ok()
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
    ) -> Result<String, String> {
        #[derive(Deserialize)]
        struct SessionData {
            id: String,
        }
        #[derive(Deserialize)]
        struct Envelope {
            data: SessionData,
        }

        let mut body = json!({ "directory": directory });
        if let Some((provider_id, model_id)) = model {
            body["model"] = json!({
                "providerID": provider_id,
                "id": model_id,
            });
        }

        let env: Envelope = self.post_json("/api/session", &body).await?;
        Ok(env.data.id)
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

    /// 打开 `/api/event` SSE 字节流（调用方自行解析）。
    pub async fn open_event_stream(&self) -> Result<reqwest::Response, String> {
        self.http
            .get(self.url("/api/event"))
            .basic_auth("opencode", Some(&self.endpoint.password))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|e| format!("OpenCode SSE 连接失败: {e}"))
    }
}
