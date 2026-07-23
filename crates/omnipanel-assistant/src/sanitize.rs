use serde_json::{Map, Value};

/// 递归剔除明显敏感键（password / secret / token / key / credential 等）。
pub fn strip_secret_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if is_secret_key(k) {
                    continue;
                }
                out.insert(k.clone(), strip_secret_keys(v));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(strip_secret_keys).collect()),
        other => other.clone(),
    }
}

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
            | "credential"
            | "credential_ref"
            | "credentialref"
            | "auth_value"
            | "authvalue"
            | "api_key"
            | "apikey"
            | "authorization"
    ) || lower.contains("password")
        || lower.contains("secret")
        || lower.ends_with("_token")
        || lower.ends_with("token")
            && !matches!(lower.as_str(), "continuationtoken" | "continuation_token")
}

/// 统一连接表记录 → 脱敏元数据（不含 credential_ref；config JSON 去敏感键）。
pub fn sanitize_connection_meta(
    id: &str,
    kind: &str,
    name: &str,
    group: &str,
    env_tag: &str,
    tags: &[String],
    config_json: &str,
) -> Value {
    let mut config: Value = serde_json::from_str(config_json).unwrap_or_else(|_| Value::Object(Map::new()));
    config = strip_secret_keys(&config);
    // 常见字段再保险剔除
    if let Some(obj) = config.as_object_mut() {
        for key in [
            "password",
            "privateKey",
            "private_key",
            "passphrase",
            "key",
            "token",
            "secret",
            "authValue",
            "auth_value",
        ] {
            obj.remove(key);
        }
    }

    serde_json::json!({
        "id": id,
        "kind": kind,
        "name": name,
        "group": group,
        "envTag": env_tag,
        "tags": tags,
        "config": config,
    })
}

/// 数据库连接配置脱敏（独立 connections.json 路径）。
pub fn sanitize_db_connection_meta(
    id: &str,
    name: &str,
    db_type: &str,
    host: &str,
    port: u16,
    user: &str,
    database: &str,
    ssl: bool,
    status: &str,
    enabled: bool,
) -> Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "dbType": db_type,
        "host": host,
        "port": port,
        "user": user,
        "database": database,
        "ssl": ssl,
        "status": status,
        "enabled": enabled,
    })
}

/// 知识库文档元数据（不含正文 content）。
pub fn sanitize_knowledge_meta(
    id: &str,
    kind: &str,
    title: &str,
    tags: &[String],
    risk_level: &str,
    source: &str,
    env_tag: &str,
    language: &str,
    node_type: &str,
    parent_id: &str,
    resource_type: &str,
    resource_id: &str,
    updated_at: i64,
) -> Value {
    serde_json::json!({
        "id": id,
        "kind": kind,
        "title": title,
        "tags": tags,
        "riskLevel": risk_level,
        "source": source,
        "envTag": env_tag,
        "language": language,
        "nodeType": node_type,
        "parentId": parent_id,
        "resourceType": resource_type,
        "resourceId": resource_id,
        "updatedAt": updated_at,
    })
}

/// HTTP/协议请求元数据（不含 headers/body/auth）。
pub fn sanitize_http_request_meta(
    id: &str,
    name: &str,
    method: &str,
    url: &str,
    collection_id: Option<&str>,
    environment_id: Option<&str>,
    updated_at: i64,
) -> Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "method": method,
        "url": url,
        "collectionId": collection_id,
        "environmentId": environment_id,
        "updatedAt": updated_at,
    })
}

/// 任务中心条目脱敏（不含 command/output 中可能夹带的密钥；仅摘要字段）。
pub fn sanitize_task_meta(
    id: &str,
    task_type: &str,
    title: &str,
    resource_id: &str,
    resource_name: &str,
    env_tag: &str,
    risk: &str,
    status: &str,
    source: &str,
    updated_at: i64,
) -> Value {
    serde_json::json!({
        "id": id,
        "taskType": task_type,
        "title": title,
        "resourceId": resource_id,
        "resourceName": resource_name,
        "envTag": env_tag,
        "risk": risk,
        "status": status,
        "source": source,
        "updatedAt": updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_password_from_nested_config() {
        let raw = serde_json::json!({
            "host": "db.local",
            "password": "secret",
            "nested": { "token": "abc", "port": 3306 }
        });
        let cleaned = strip_secret_keys(&raw);
        assert_eq!(cleaned["host"], "db.local");
        assert!(cleaned.get("password").is_none());
        assert!(cleaned["nested"].get("token").is_none());
        assert_eq!(cleaned["nested"]["port"], 3306);
    }

    #[test]
    fn sanitize_connection_drops_credential_ref_and_password() {
        let meta = sanitize_connection_meta(
            "c1",
            "ssh",
            "prod",
            "default",
            "prod",
            &["os:linux".into()],
            r#"{"host":"1.2.3.4","password":"x","port":22}"#,
        );
        assert_eq!(meta["id"], "c1");
        assert!(meta.get("credentialRef").is_none());
        assert!(meta["config"].get("password").is_none());
        assert_eq!(meta["config"]["host"], "1.2.3.4");
    }
}
