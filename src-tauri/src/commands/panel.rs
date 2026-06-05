use omnipanel_error::OmniError;
use serde_json::Value;

/// 通用 1Panel API 请求（由 Rust 后端发起，避免 WebView CORS）。
/// `body` 为 JSON 字符串；返回 JSON 字符串。
#[tauri::command]
#[specta::specta]
pub async fn panel_1panel_request(
    host: String,
    api_key: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, OmniError> {
    let body_val = match body {
        Some(raw) if !raw.trim().is_empty() => {
            Some(serde_json::from_str::<Value>(&raw).map_err(|e| {
                OmniError::invalid_input("请求体不是合法 JSON").with_cause(e.to_string())
            })?)
        }
        _ => None,
    };

    let result =
        crate::panel::onepanel::request(&host, &api_key, &method, &path, body_val).await?;
    serde_json::to_string(&result)
        .map_err(|e| OmniError::internal("序列化 1Panel 响应失败").with_cause(e.to_string()))
}

/// 1Panel 连通性测试。
#[tauri::command]
#[specta::specta]
pub async fn panel_1panel_test_connection(host: String, api_key: String) -> Result<bool, OmniError> {
    crate::panel::onepanel::test_connection(&host, &api_key).await?;
    Ok(true)
}

/// 获取 1Panel 应用图标（GET /apps/icon/:key），返回 data URL 或绝对 URL。
#[tauri::command]
#[specta::specta]
pub async fn panel_1panel_app_icon(
    host: String,
    api_key: String,
    app_key: String,
) -> Result<String, OmniError> {
    crate::panel::onepanel::fetch_app_icon(&host, &api_key, &app_key).await
}

/// 1Panel 原始文本请求（用于日志下载等）。
#[tauri::command]
#[specta::specta]
pub async fn panel_1panel_request_text(
    host: String,
    api_key: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, OmniError> {
    let body_val = match body {
        Some(raw) if !raw.trim().is_empty() => {
            Some(serde_json::from_str::<Value>(&raw).map_err(|e| {
                OmniError::invalid_input("请求体不是合法 JSON").with_cause(e.to_string())
            })?)
        }
        _ => None,
    };

    crate::panel::onepanel::request_text(&host, &api_key, &method, &path, body_val).await
}

/// 通用宝塔面板 API 请求（POST + 表单签名，由 Rust 后端发起并维护 Cookie）。
/// `path` 含 query，如 `/system?action=GetSystemTotal`；`body` 为额外字段的 JSON 对象字符串。
#[tauri::command]
#[specta::specta]
pub async fn panel_bt_request(
    host: String,
    api_sk: String,
    path: String,
    body: Option<String>,
) -> Result<String, OmniError> {
    let body_map = match body {
        Some(raw) if !raw.trim().is_empty() => {
            let value = serde_json::from_str::<Value>(&raw).map_err(|e| {
                OmniError::invalid_input("请求体不是合法 JSON").with_cause(e.to_string())
            })?;
            match value {
                Value::Object(map) => Some(map),
                Value::Null => None,
                _ => {
                    return Err(OmniError::invalid_input(
                        "宝塔 API 请求体必须是 JSON 对象",
                    ));
                }
            }
        }
        _ => None,
    };

    let result = crate::panel::btpanel::request(&host, &api_sk, &path, body_map).await?;
    serde_json::to_string(&result)
        .map_err(|e| OmniError::internal("序列化宝塔面板响应失败").with_cause(e.to_string()))
}

/// 宝塔面板连通性测试。
#[tauri::command]
#[specta::specta]
pub async fn panel_bt_test_connection(host: String, api_sk: String) -> Result<bool, OmniError> {
    crate::panel::btpanel::test_connection(&host, &api_sk).await?;
    Ok(true)
}
