#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendKind {
    /// 第三方 CLI 智能体（OpenCode / Cursor / …）
    Cli,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBackendId {
    pub kind: BackendKind,
    /// CLI provider id（如 opencode、cursor）
    pub provider_id: String,
    /// CLI model name
    pub model_id: String,
}

/// Parse `cli:{providerId}::{modelId}`。
pub fn parse_backend_id(backend_id: &str) -> Result<ParsedBackendId, String> {
    let trimmed = backend_id.trim();
    if trimmed.is_empty() {
        return Err("backend_id 不能为空".to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("cli:") {
        let (provider_id, model_id) = split_provider_model(rest)?;
        if provider_id.is_empty() || model_id.is_empty() {
            return Err(format!("无效的 CLI backend_id: {backend_id}"));
        }
        return Ok(ParsedBackendId {
            kind: BackendKind::Cli,
            provider_id,
            model_id,
        });
    }

    Err(format!(
        "无法解析 backend_id: {backend_id}（期望 cli:provider::model）"
    ))
}

/// 从已解析的 CLI backend 取出 provider + model。
pub fn normalize_cli_backend(parsed: &ParsedBackendId) -> Result<(String, String), String> {
    match parsed.kind {
        BackendKind::Cli => {
            if parsed.model_id.is_empty() {
                return Err("CLI backend 缺少 model".to_string());
            }
            Ok((parsed.provider_id.clone(), parsed.model_id.clone()))
        }
    }
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
    fn parse_cli_backend() {
        let parsed = parse_backend_id("cli:cursor::gpt-4").unwrap();
        assert_eq!(parsed.kind, BackendKind::Cli);
        assert_eq!(parsed.provider_id, "cursor");
        assert_eq!(parsed.model_id, "gpt-4");
    }

    #[test]
    fn reject_http_and_acp() {
        assert!(parse_backend_id("http:provider_1::gpt-4o-mini").is_err());
        assert!(parse_backend_id("acp:cursor").is_err());
    }

    #[test]
    fn normalize_cli() {
        let parsed = parse_backend_id("cli:opencode::default").unwrap();
        let (provider, model) = normalize_cli_backend(&parsed).unwrap();
        assert_eq!(provider, "opencode");
        assert_eq!(model, "default");
    }
}
