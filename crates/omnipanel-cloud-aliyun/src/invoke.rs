use omnipanel_error::{ErrorCode, OmniError};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::client::AliyunCredentials;
use crate::driver::{AliyunCloudDriver, CloudProviderDriver};
use crate::types::{CloudAction, CloudLogQuery, CloudMetricQuery, CloudResourceFilter};

const INVOKE_METHODS: &[&str] = &[
    "testAccount",
    "listRegions",
    "getAccount",
    "listResources",
    "getResource",
    "invokeAction",
    "getMetrics",
    "queryLogs",
];

pub fn is_declared_method(method: &str) -> bool {
    INVOKE_METHODS.contains(&method)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeCredentials {
    access_key_id: String,
    access_key_secret: String,
    #[serde(default)]
    region: String,
}

fn parse_creds(args: &Value) -> Result<AliyunCredentials, OmniError> {
    let creds: InvokeCredentials = serde_json::from_value(
        args.get("credentials")
            .cloned()
            .or_else(|| args.get("creds").cloned())
            .unwrap_or(Value::Null),
    )
    .map_err(|_| OmniError::invalid_input("缺少云厂商凭据"))?;
    if creds.access_key_id.trim().is_empty() || creds.access_key_secret.trim().is_empty() {
        return Err(OmniError::invalid_input("缺少 AccessKey"));
    }
    Ok(AliyunCredentials {
        access_key_id: creds.access_key_id.trim().to_string(),
        access_key_secret: creds.access_key_secret,
        region: if creds.region.trim().is_empty() {
            "cn-hangzhou".into()
        } else {
            creds.region.trim().to_string()
        },
        regions: Vec::new(),
    })
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn configured_regions(args: &Value) -> Vec<String> {
    args.get("configuredRegions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn default_http_client() -> Result<Client, OmniError> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e.to_string()))
}

/// InvokeGateway 入口：解析 JSON 参数并调用 Driver。凭据只存在此次调用栈。
pub async fn handle_invoke(method: &str, args: Value) -> Result<Value, OmniError> {
    if !is_declared_method(method) {
        return Err(OmniError::invalid_input(format!("未声明方法: {method}")));
    }
    let http = default_http_client()?;
    let creds = parse_creds(&args)?;
    let driver = AliyunCloudDriver;
    match method {
        "testAccount" => {
            let msg = driver.test_account(&creds, &http).await?;
            Ok(Value::String(msg))
        }
        "listRegions" => {
            let configured = configured_regions(&args);
            let list = driver.list_regions(&creds, &http, &configured).await?;
            serde_json::to_value(list).map_err(|e| OmniError::internal(e.to_string()))
        }
        "getAccount" => {
            let snap = driver.get_account(&creds, &http).await?;
            serde_json::to_value(snap).map_err(|e| OmniError::internal(e.to_string()))
        }
        "listResources" => {
            let capability = arg_str(&args, "capability");
            let filter: CloudResourceFilter = args
                .get("filter")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| OmniError::invalid_input(e.to_string()))?
                .unwrap_or_default();
            let list = driver
                .list_resources(&creds, &http, &capability, &filter)
                .await?;
            serde_json::to_value(list).map_err(|e| OmniError::internal(e.to_string()))
        }
        "getResource" => {
            let capability = arg_str(&args, "capability");
            let resource_id = arg_str(&args, "resourceId");
            let region_id = arg_str(&args, "regionId");
            let detail = driver
                .get_resource(&creds, &http, &capability, &resource_id, &region_id)
                .await?;
            serde_json::to_value(detail).map_err(|e| OmniError::internal(e.to_string()))
        }
        "invokeAction" => {
            let action: CloudAction = serde_json::from_value(
                args.get("action").cloned().unwrap_or_else(|| args.clone()),
            )
            .map_err(|e| OmniError::invalid_input(e.to_string()))?;
            let result = driver.invoke_action(&creds, &http, &action).await?;
            serde_json::to_value(result).map_err(|e| OmniError::internal(e.to_string()))
        }
        "getMetrics" => {
            let capability = arg_str(&args, "capability");
            let resource_id = arg_str(&args, "resourceId");
            let region_id = arg_str(&args, "regionId");
            let query: CloudMetricQuery = args
                .get("query")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| OmniError::invalid_input(e.to_string()))?
                .unwrap_or_default();
            let series = driver
                .get_metrics(&creds, &http, &capability, &resource_id, &region_id, &query)
                .await?;
            serde_json::to_value(series).map_err(|e| OmniError::internal(e.to_string()))
        }
        "queryLogs" => {
            let capability = arg_str(&args, "capability");
            let resource_id = arg_str(&args, "resourceId");
            let region_id = arg_str(&args, "regionId");
            let query: CloudLogQuery = args
                .get("query")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| OmniError::invalid_input(e.to_string()))?
                .unwrap_or_default();
            let page = driver
                .query_logs(&creds, &http, &capability, &resource_id, &region_id, &query)
                .await?;
            serde_json::to_value(page).map_err(|e| OmniError::internal(e.to_string()))
        }
        other => Err(OmniError::invalid_input(format!("未声明方法: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_methods_whitelist() {
        assert!(is_declared_method("listResources"));
        assert!(is_declared_method("getAccount"));
        assert!(!is_declared_method("cloudListEcs"));
        assert!(!is_declared_method("deleteInstance"));
    }
}
