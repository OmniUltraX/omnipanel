//! 工具结果回灌 AI 前的密钥打码（与前端 `redactSecrets.ts` / assistant sanitize 对齐）。

const REDACTED: &str = "***";

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "password"
            | "passwd"
            | "secret"
            | "token"
            | "accesskey"
            | "access_key"
            | "accesskeyid"
            | "accesskeysecret"
            | "access_key_secret"
            | "securitytoken"
            | "security_token"
            | "privatekey"
            | "private_key"
            | "privatekeypath"
            | "passphrase"
            | "pem"
            | "credential"
            | "credential_ref"
            | "credentialref"
            | "auth_value"
            | "authvalue"
            | "api_key"
            | "apikey"
            | "authorization"
            | "key"
    ) || lower.contains("password")
        || lower.contains("secret")
        || lower.contains("passphrase")
        || ((lower.ends_with("_token") || lower.ends_with("token"))
            && !matches!(lower.as_str(), "continuationtoken" | "continuation_token"))
}

fn is_secret_env_key(key: &str) -> bool {
    is_secret_key(key) || {
        let lower = key.to_ascii_lowercase();
        lower.contains("apikey") || lower.contains("api_key")
    }
}

fn looks_like_secret_token(token: &str) -> bool {
    token.starts_with("sk-") && token.len() > 12
        || token.starts_with("AKIA") && token.len() > 16
        || token.starts_with("ghp_") && token.len() > 20
        || token.starts_with("glpat-") && token.len() > 20
        || (token.starts_with("eyJ") && token.matches('.').count() >= 2 && token.len() > 40)
}

fn redact_value_patterns(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric()
                || bytes[i] == b'-'
                || bytes[i] == b'_'
                || bytes[i] == b'.')
        {
            i += 1;
        }
        if i > start {
            let word = &text[start..i];
            if looks_like_secret_token(word) {
                out.push_str(&text[last..start]);
                out.push_str(REDACTED);
                last = i;
            }
        }
        if i < bytes.len() {
            i += 1;
        } else {
            break;
        }
    }
    out.push_str(&text[last..]);
    out
}

fn redact_env_line(line: &str) -> String {
    if let Some((key, value)) = line.split_once('=') {
        if is_secret_env_key(key) && !value.is_empty() {
            return format!("{key}={REDACTED}");
        }
        return format!("{key}={}", redact_value_patterns(value));
    }
    redact_value_patterns(line)
}

fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if is_secret_key(k) {
                    let empty = v.as_str().is_some_and(|s| s.is_empty());
                    out.insert(
                        k.clone(),
                        if empty {
                            serde_json::Value::String(String::new())
                        } else {
                            serde_json::Value::String(REDACTED.to_string())
                        },
                    );
                    continue;
                }
                if k.eq_ignore_ascii_case("env") {
                    if let serde_json::Value::Array(arr) = v {
                        let redacted: Vec<serde_json::Value> = arr
                            .iter()
                            .map(|item| match item {
                                serde_json::Value::String(s) => {
                                    serde_json::Value::String(redact_env_line(s))
                                }
                                other => redact_json(other),
                            })
                            .collect();
                        out.insert(k.clone(), serde_json::Value::Array(redacted));
                        continue;
                    }
                }
                out.insert(k.clone(), redact_json(v));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(arr) => serde_json::Value::Array(
            arr.iter()
                .map(|item| match item {
                    serde_json::Value::String(s) if s.contains('=') => {
                        serde_json::Value::String(redact_env_line(s))
                    }
                    other => redact_json(other),
                })
                .collect(),
        ),
        serde_json::Value::String(s) => serde_json::Value::String(redact_value_patterns(s)),
        other => other.clone(),
    }
}

/// 对工具结果文本做密钥打码。
pub fn redact_secrets_in_text(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return input.to_string();
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Ok(pretty) = serde_json::to_string_pretty(&redact_json(&parsed)) {
            return pretty;
        }
    }
    input
        .lines()
        .map(|line| {
            let t = line.trim();
            if let Some((k, _)) = t.split_once('=') {
                if k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !k.is_empty() {
                    return redact_env_line(t);
                }
            }
            redact_value_patterns(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_env_password_in_json() {
        let input = r#"{"env":["PATH=/bin","MYSQL_PASSWORD=s3cret","OK=1"]}"#;
        let out = redact_secrets_in_text(input);
        assert!(out.contains("MYSQL_PASSWORD=***"), "{out}");
        assert!(out.contains("PATH=/bin"), "{out}");
        assert!(!out.contains("s3cret"), "{out}");
    }

    #[test]
    fn redacts_sk_prefix() {
        let out = redact_secrets_in_text("token sk-abcdefghijklmnopqrstuvwxyz here");
        assert!(out.contains("***"), "{out}");
        assert!(!out.contains("sk-abcdefghijklmnopqrstuvwxyz"), "{out}");
    }

    #[test]
    fn strips_password_object_key() {
        let input = r#"{"password":"x","host":"h"}"#;
        let out = redact_secrets_in_text(input);
        assert!(out.contains("***"), "{out}");
        assert!(out.contains("\"host\""), "{out}");
        assert!(!out.contains("\"x\""), "{out}");
    }
}
