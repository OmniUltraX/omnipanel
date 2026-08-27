//! HTTP 推理 API 路由：同一 base URL 下按模型选择 OpenAI Chat Completions 或 Anthropic Messages。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpInferenceApi {
    OpenAiChatCompletions,
    AnthropicMessages,
}

/// 根据 provider 配置与模型 ID 选择 HTTP 推理 API。
pub fn resolve_http_inference_api(api_standard: &str, model_id: &str) -> HttpInferenceApi {
    if api_standard.eq_ignore_ascii_case("anthropic") {
        return HttpInferenceApi::AnthropicMessages;
    }
    if model_requires_anthropic_messages_api(model_id) {
        return HttpInferenceApi::AnthropicMessages;
    }
    HttpInferenceApi::OpenAiChatCompletions
}

/// Bedrock 等网关上的 Claude 模型 ID 前缀（仅 Messages API，不支持 chat/completions）。
pub fn model_requires_anthropic_messages_api(model_id: &str) -> bool {
    model_id.trim().starts_with("anthropic.")
}

/// 将 OpenAI 风格 base（`…/v1`）转为 Bedrock Mantle 的 Anthropic Messages base（`…/anthropic/v1`）。
pub fn resolve_anthropic_messages_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains("bedrock-mantle") {
        if trimmed.ends_with("/anthropic/v1") {
            return trimmed.to_string();
        }
        if let Some(root) = trimmed.strip_suffix("/v1") {
            return format!("{root}/anthropic/v1");
        }
        if trimmed.ends_with("/anthropic") {
            return format!("{trimmed}/v1");
        }
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_standard_uses_messages_api() {
        assert_eq!(
            resolve_http_inference_api("anthropic", "claude-sonnet-4"),
            HttpInferenceApi::AnthropicMessages
        );
    }

    #[test]
    fn bedrock_anthropic_model_on_openai_provider_uses_messages_api() {
        assert_eq!(
            resolve_http_inference_api("openai", "anthropic.claude-haiku-4-5"),
            HttpInferenceApi::AnthropicMessages
        );
    }

    #[test]
    fn openai_gpt_model_uses_chat_completions() {
        assert_eq!(
            resolve_http_inference_api("openai", "openai.gpt-oss-120b"),
            HttpInferenceApi::OpenAiChatCompletions
        );
    }

    #[test]
    fn bedrock_mantle_base_url_rewrite() {
        assert_eq!(
            resolve_anthropic_messages_base_url(
                "https://bedrock-mantle.eu-north-1.api.aws/v1"
            ),
            "https://bedrock-mantle.eu-north-1.api.aws/anthropic/v1"
        );
        assert_eq!(
            resolve_anthropic_messages_base_url(
                "https://bedrock-mantle.eu-north-1.api.aws/anthropic/v1"
            ),
            "https://bedrock-mantle.eu-north-1.api.aws/anthropic/v1"
        );
    }

    #[test]
    fn anthropic_official_base_url_unchanged() {
        assert_eq!(
            resolve_anthropic_messages_base_url("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1"
        );
    }
}
