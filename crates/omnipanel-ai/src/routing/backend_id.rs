#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendKind {
    Http,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBackendId {
    pub kind: BackendKind,
    pub provider_id: String,
    pub model_id: String,
}

/// 解析 `http:{providerId}::{modelId}`。
///
/// 旧的 `cli:` / `acp:` 整轮外派已移除，遇到时直接拒绝。
pub fn parse_backend_id(backend_id: &str) -> Result<ParsedBackendId, String> {
    let trimmed = backend_id.trim();
    if trimmed.is_empty() {
        return Err("backend_id 不能为空".to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("http:") {
        let (provider_id, model_id) = split_provider_model(rest)?;
        if provider_id.is_empty() || model_id.is_empty() {
            return Err(format!("无效的 HTTP backend_id: {backend_id}"));
        }
        return Ok(ParsedBackendId {
            kind: BackendKind::Http,
            provider_id,
            model_id,
        });
    }

    if trimmed.starts_with("cli:") || trimmed.starts_with("acp:") {
        return Err("CLI / ACP 整轮外派已移除，请改用模型桥（http:{来源}::{模型}）".to_string());
    }

    Err(format!(
        "无法解析 backend_id: {backend_id}（期望 http:provider::model）"
    ))
}

fn split_provider_model(rest: &str) -> Result<(String, String), String> {
    const SEP: &str = "::";
    let sep_pos = rest
        .rfind(SEP)
        .ok_or_else(|| format!("backend_id 缺少 '{SEP}' 分隔符: {rest}"))?;
    let provider_id = rest[..sep_pos].trim().to_string();
    let model_id = rest[sep_pos + SEP.len()..].trim().to_string();
    Ok((provider_id, model_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_http_backend() {
        let parsed = parse_backend_id("http:provider_1::gpt-4o-mini").unwrap();
        assert_eq!(parsed.kind, BackendKind::Http);
        assert_eq!(parsed.provider_id, "provider_1");
        assert_eq!(parsed.model_id, "gpt-4o-mini");
    }

    #[test]
    fn reject_removed_cli_and_acp_backends() {
        assert!(parse_backend_id("cli:cursor::gpt-4").is_err());
        assert!(parse_backend_id("acp:cursor").is_err());
    }
}
