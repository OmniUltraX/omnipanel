#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendKind {
    /// 第三方 CLI 智能体（Cursor / …），走 ACP
    Cli,
    /// OpenCode HTTP Client（`opencode serve`）
    OpenCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBackendId {
    pub kind: BackendKind,
    /// CLI：智能体 id（如 cursor）；OpenCode：LLM providerID（如 opencode、opencode-go）
    pub provider_id: String,
    /// 模型 id
    pub model_id: String,
}

/// Parse `cli:{providerId}::{modelId}` 或 `opencode:{providerId}/{modelId}`。
pub fn parse_backend_id(backend_id: &str) -> Result<ParsedBackendId, String> {
    let trimmed = backend_id.trim();
    if trimmed.is_empty() {
        return Err("backend_id 不能为空".to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("opencode:") {
        let (provider_id, model_id) = split_provider_slash_model(rest)?;
        if provider_id.is_empty() || model_id.is_empty() {
            return Err(format!("无效的 OpenCode backend_id: {backend_id}"));
        }
        return Ok(ParsedBackendId {
            kind: BackendKind::OpenCode,
            provider_id,
            model_id,
        });
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
        "无法解析 backend_id: {backend_id}（期望 cli:provider::model 或 opencode:provider/model）"
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
        BackendKind::OpenCode => Err(
            "backend 为 OpenCode HTTP，请使用 normalize_opencode_backend".to_string(),
        ),
    }
}

/// 从已解析的 OpenCode backend 取出 LLM providerID + modelID。
pub fn normalize_opencode_backend(parsed: &ParsedBackendId) -> Result<(String, String), String> {
    match parsed.kind {
        BackendKind::OpenCode => {
            if parsed.provider_id.is_empty() || parsed.model_id.is_empty() {
                return Err("OpenCode backend 缺少 provider/model".to_string());
            }
            Ok((parsed.provider_id.clone(), parsed.model_id.clone()))
        }
        BackendKind::Cli => Err(
            "backend 为 CLI，请使用 normalize_cli_backend".to_string(),
        ),
    }
}

/// 构造 `opencode:{providerId}/{modelId}`。
pub fn build_opencode_backend_id(provider_id: &str, model_id: &str) -> String {
    format!("opencode:{provider_id}/{model_id}")
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

fn split_provider_slash_model(rest: &str) -> Result<(String, String), String> {
    let trimmed = rest.trim();
    let slash = trimmed
        .find('/')
        .ok_or_else(|| format!("OpenCode backend_id 缺少 '/' 分隔符: {trimmed}"))?;
    let provider_id = trimmed[..slash].trim().to_string();
    let model_id = trimmed[slash + 1..].trim().to_string();
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
    fn parse_opencode_backend() {
        let parsed = parse_backend_id("opencode:opencode/big-pickle").unwrap();
        assert_eq!(parsed.kind, BackendKind::OpenCode);
        assert_eq!(parsed.provider_id, "opencode");
        assert_eq!(parsed.model_id, "big-pickle");

        let (p, m) = normalize_opencode_backend(&parsed).unwrap();
        assert_eq!(p, "opencode");
        assert_eq!(m, "big-pickle");
        assert_eq!(
            build_opencode_backend_id(&p, &m),
            "opencode:opencode/big-pickle"
        );
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
