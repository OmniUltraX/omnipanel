//! Web IPC adaptation of the desktop `src-tauri/src/commands/panel.rs` commands.
//!
//! These calls proxy 1Panel / BT-Panel API requests through the Rust backend so the
//! browser never hits their CORS-restricted endpoints directly.

use omnipanel_error::OmniError;
use omnipanel_store::{ConnectionKind, Vault};
use serde_json::Value;

use crate::terminal::ServerState;

fn parse_optional_json_body(body: Option<String>) -> Result<Option<Value>, OmniError> {
    match body {
        Some(raw) if !raw.trim().is_empty() => {
            let value = serde_json::from_str::<Value>(&raw)
                .map_err(|e| OmniError::invalid_input("request body is not valid JSON").with_cause(e.to_string()))?;
            Ok(Some(value))
        }
        _ => Ok(None),
    }
}

/// Resolve a panel connection's API key from the Vault (config.key is cleared on save).
pub async fn panel_resolve_api_key(
    state: &ServerState,
    connection_id: String,
) -> Result<String, OmniError> {
    if connection_id.trim().is_empty() {
        return Err(OmniError::invalid_input("connection id must not be empty"));
    }

    let storage = state.storage.lock().await;
    let conn = storage
        .get_connection(&connection_id)?
        .ok_or_else(|| OmniError::invalid_input(format!("panel connection not found: {connection_id}")))?;
    drop(storage);

    if conn.kind != ConnectionKind::Panel {
        return Err(OmniError::invalid_input("target connection is not a panel connection"));
    }

    let key = conn
        .credential_ref
        .as_deref()
        .filter(|r| {
            r.starts_with("panel-key-")
                || r.starts_with("docker-btpanel-")
                || r.starts_with("docker-onepanel-")
        })
        .and_then(|r| Vault::get(r).ok())
        .or_else(|| Vault::get(&format!("panel-key-{connection_id}")).ok())
        .unwrap_or_default();

    if key.trim().is_empty() {
        return Err(OmniError::invalid_input("panel API key not found, please re-save the connection"));
    }
    Ok(key.trim().to_string())
}

/// Generic 1Panel API request (issued from the Rust backend to avoid WebView CORS).
/// `body` is a JSON string; the return value is a JSON string.
pub async fn panel_1panel_request(
    host: String,
    api_key: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, OmniError> {
    let body_val = parse_optional_json_body(body)?;
    let result = crate::panel::onepanel::request(&host, &api_key, &method, &path, body_val).await?;
    serde_json::to_string(&result)
        .map_err(|e| OmniError::internal("failed to serialize 1Panel response").with_cause(e.to_string()))
}

/// 1Panel connectivity test.
pub async fn panel_1panel_test_connection(host: String, api_key: String) -> Result<bool, OmniError> {
    crate::panel::onepanel::test_connection(&host, &api_key).await?;
    Ok(true)
}

/// Fetch a 1Panel app icon (GET /apps/icon/:key); returns a data URL or absolute URL.
pub async fn panel_1panel_app_icon(
    host: String,
    api_key: String,
    app_key: String,
) -> Result<String, OmniError> {
    crate::panel::onepanel::fetch_app_icon(&host, &api_key, &app_key).await
}

/// 1Panel raw text request (used for log downloads etc).
pub async fn panel_1panel_request_text(
    host: String,
    api_key: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, OmniError> {
    let body_val = parse_optional_json_body(body)?;
    crate::panel::onepanel::request_text(&host, &api_key, &method, &path, body_val).await
}

/// 1Panel binary request (certificate zip etc). Returns Base64 to avoid IPC corruption.
pub async fn panel_1panel_request_bytes(
    host: String,
    api_key: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<crate::panel::onepanel::OnePanelBinaryPayload, OmniError> {
    let body_val = parse_optional_json_body(body)?;
    crate::panel::onepanel::request_bytes(&host, &api_key, &method, &path, body_val).await
}

/// 1Panel file upload (multipart /files/upload, or chunked /files/chunkupload).
/// `content_base64` is the file content as Base64; `path` is the target directory.
pub async fn panel_1panel_upload_file(
    host: String,
    api_key: String,
    path: String,
    filename: String,
    content_base64: String,
    overwrite: Option<bool>,
) -> Result<(), OmniError> {
    crate::panel::onepanel::upload_file(
        &host,
        &api_key,
        &path,
        &filename,
        &content_base64,
        overwrite.unwrap_or(true),
    )
    .await
}

/// Generic BT-Panel API request (POST + form signature, issued from the Rust backend which
/// also maintains the cookie jar).
/// `path` may include a query string, e.g. `/system?action=GetSystemTotal`; `body` is the
/// extra fields as a JSON object string.
pub async fn panel_bt_request(
    host: String,
    api_sk: String,
    path: String,
    body: Option<String>,
) -> Result<String, OmniError> {
    let body_map = match parse_optional_json_body(body)? {
        Some(Value::Object(map)) => Some(map),
        Some(Value::Null) | None => None,
        Some(_) => {
            return Err(OmniError::invalid_input("BT-Panel API request body must be a JSON object"));
        }
    };

    let result = crate::panel::btpanel::request(&host, &api_sk, &path, body_map).await?;
    serde_json::to_string(&result)
        .map_err(|e| OmniError::internal("failed to serialize BT-Panel response").with_cause(e.to_string()))
}

/// BT-Panel connectivity test.
pub async fn panel_bt_test_connection(host: String, api_sk: String) -> Result<bool, OmniError> {
    crate::panel::btpanel::test_connection(&host, &api_sk).await?;
    Ok(true)
}

/// Fetch a BT-Panel app-store icon, returned as a data URL (authenticated download,
/// bypasses the security entrance).
/// `icon_file` is optional; app-store icons are usually named `ico-xxx.png`. When empty,
/// the Docker/software path is inferred from `app_name`.
pub async fn panel_bt_app_icon(
    host: String,
    api_sk: String,
    app_name: String,
    icon_file: Option<String>,
) -> Result<String, OmniError> {
    crate::panel::btpanel::fetch_docker_app_icon(&host, &api_sk, &app_name, icon_file.as_deref()).await
}