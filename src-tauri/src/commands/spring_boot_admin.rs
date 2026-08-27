use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::State;

use crate::commands::proxy::{build_http_client_for_url, normalize_localhost_url};
use crate::state::AppState;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SbaInstanceInfo {
    pub id: String,
    pub application: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SbaJvmSnapshot {
    pub threads_live: Option<f64>,
    pub threads_daemon: Option<f64>,
    pub threads_peak: Option<f64>,
    pub heap_used: Option<f64>,
    pub heap_committed: Option<f64>,
    pub heap_max: Option<f64>,
    pub non_heap_used: Option<f64>,
    pub non_heap_committed: Option<f64>,
    pub non_heap_max: Option<f64>,
    pub non_heap_init: Option<f64>,
}

fn normalize_admin_url(raw: &str) -> Result<String, OmniError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(OmniError::invalid_input("请输入 Spring Boot Admin 地址"));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = normalize_localhost_url(&with_scheme);
    let parsed = url::Url::parse(&url).map_err(|_| {
        OmniError::invalid_input("Spring Boot Admin 地址无效，需为 http(s) URL")
    })?;
    match parsed.scheme() {
        "http" | "https" => Ok(url.trim_end_matches('/').to_string()),
        _ => Err(OmniError::invalid_input(
            "Spring Boot Admin 地址仅支持 http / https",
        )),
    }
}

fn map_http_client_err(err: String) -> OmniError {
    OmniError::new(ErrorCode::Connection, "无法创建 HTTP 客户端").with_cause(err)
}

fn instance_actuator_url(base: &str, instance_id: &str, suffix: &str) -> String {
    let encoded_id = urlencoding::encode(instance_id);
    format!("{base}/instances/{encoded_id}/actuator/{suffix}")
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, OmniError> {
    let resp = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| {
            OmniError::connection("请求 Spring Boot Admin 失败").with_cause(e.to_string())
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::connection("读取 Spring Boot Admin 响应失败").with_cause(e.to_string())
    })?;
    if status.is_client_error() || status.is_server_error() {
        let err = if status.as_u16() == 401 || status.as_u16() == 403 {
            OmniError::auth("Spring Boot Admin 需要认证")
        } else {
            OmniError::connection(format!("Spring Boot Admin 返回 {status}"))
        };
        return Err(err.with_cause(body.chars().take(300).collect::<String>()));
    }
    serde_json::from_str(&body).map_err(|e| {
        OmniError::internal("无法解析 Spring Boot Admin JSON").with_cause(e.to_string())
    })
}

fn metric_value(json: &Value) -> Option<f64> {
    let measurements = json.get("measurements")?.as_array()?;
    for item in measurements {
        let stat = item
            .get("statistic")
            .and_then(|v| v.as_str())
            .unwrap_or("VALUE");
        if stat.eq_ignore_ascii_case("VALUE") || stat.eq_ignore_ascii_case("COUNT") {
            if let Some(v) = json_f64(item.get("value")) {
                return Some(v);
            }
        }
    }
    json_f64(measurements.first().and_then(|item| item.get("value")))
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let n = value
        .as_f64()
        .or_else(|| value.as_i64().map(|i| i as f64))
        .or_else(|| value.as_u64().map(|i| i as f64))?;
    if n < 0.0 || !n.is_finite() {
        None
    } else {
        Some(n)
    }
}

fn parse_instances(json: &Value) -> Vec<SbaInstanceInfo> {
    let apps = if let Some(arr) = json.as_array() {
        arr.clone()
    } else if let Some(arr) = json.get("applications").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for app in apps {
        let app_name = app
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let instances = app
            .get("instances")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for inst in instances {
            let id = inst
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if id.is_empty() {
                continue;
            }
            let status = inst
                .get("status")
                .and_then(|v| v.as_str())
                .or_else(|| app.get("status").and_then(|v| v.as_str()))
                .unwrap_or("UNKNOWN")
                .to_string();
            let application = inst
                .get("registration")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| app_name.clone());
            out.push(SbaInstanceInfo {
                id,
                application,
                status,
            });
        }
    }
    out.sort_by(|a, b| {
        a.application
            .to_lowercase()
            .cmp(&b.application.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

fn jolokia_value<'a>(json: &'a Value) -> &'a Value {
    json.get("value").unwrap_or(json)
}

fn parse_jmx_memory(json: &Value) -> Option<SbaJvmSnapshot> {
    let value = jolokia_value(json);
    let heap = value.get("HeapMemoryUsage")?;
    let non_heap = value.get("NonHeapMemoryUsage")?;
    Some(SbaJvmSnapshot {
        threads_live: None,
        threads_daemon: None,
        threads_peak: None,
        heap_used: json_f64(heap.get("used")),
        heap_committed: json_f64(heap.get("committed")),
        heap_max: json_f64(heap.get("max")),
        non_heap_used: json_f64(non_heap.get("used")),
        non_heap_committed: json_f64(non_heap.get("committed")),
        non_heap_max: json_f64(non_heap.get("max")),
        non_heap_init: json_f64(non_heap.get("init")),
    })
}

fn parse_jmx_threads(json: &Value) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    let value = jolokia_value(json);
    let live = json_f64(value.get("ThreadCount"));
    let daemon = json_f64(value.get("DaemonThreadCount"));
    let peak = json_f64(value.get("PeakThreadCount"));
    if live.is_none() && daemon.is_none() && peak.is_none() {
        None
    } else {
        Some((live, daemon, peak))
    }
}

async fn fetch_metric(
    client: &reqwest::Client,
    base: &str,
    instance_id: &str,
    metric: &str,
    tag: Option<&str>,
) -> Option<f64> {
    let mut suffix = format!("metrics/{metric}");
    if let Some(tag) = tag {
        suffix.push_str("?tag=");
        suffix.push_str(&urlencoding::encode(tag));
    }
    let url = instance_actuator_url(base, instance_id, &suffix);
    let json = get_json(client, &url).await.ok()?;
    metric_value(&json)
}

fn merge_snapshot(mut base: SbaJvmSnapshot, fill: SbaJvmSnapshot) -> SbaJvmSnapshot {
    if base.threads_live.is_none() {
        base.threads_live = fill.threads_live;
    }
    if base.threads_daemon.is_none() {
        base.threads_daemon = fill.threads_daemon;
    }
    if base.threads_peak.is_none() {
        base.threads_peak = fill.threads_peak;
    }
    if base.heap_used.is_none() {
        base.heap_used = fill.heap_used;
    }
    if base.heap_committed.is_none() {
        base.heap_committed = fill.heap_committed;
    }
    if base.heap_max.is_none() {
        base.heap_max = fill.heap_max;
    }
    if base.non_heap_used.is_none() {
        base.non_heap_used = fill.non_heap_used;
    }
    if base.non_heap_committed.is_none() {
        base.non_heap_committed = fill.non_heap_committed;
    }
    if base.non_heap_max.is_none() {
        base.non_heap_max = fill.non_heap_max;
    }
    if base.non_heap_init.is_none() {
        base.non_heap_init = fill.non_heap_init;
    }
    base
}

/// 列出 Spring Boot Admin 中的应用实例。
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_admin_list_instances(
    state: State<'_, AppState>,
    admin_url: String,
) -> Result<Vec<SbaInstanceInfo>, OmniError> {
    let base = normalize_admin_url(&admin_url)?;
    let proxy = state.proxy_config.lock().await.clone();
    let client = build_http_client_for_url(&base, &proxy, REQUEST_TIMEOUT)
        .map_err(map_http_client_err)?;
    let json = match get_json(&client, &format!("{base}/applications")).await {
        Ok(v) => v,
        Err(first) => match get_json(&client, &format!("{base}/api/applications")).await {
            Ok(v) => v,
            Err(_) => return Err(first),
        },
    };
    Ok(parse_instances(&json))
}

/// 拉取实例 JVM 线程 / Heap / Non-heap 当前值（Jolokia MemoryMXBean，失败则回退 Micrometer）。
#[tauri::command]
#[specta::specta]
pub async fn spring_boot_admin_jvm_snapshot(
    state: State<'_, AppState>,
    admin_url: String,
    instance_id: String,
) -> Result<SbaJvmSnapshot, OmniError> {
    let base = normalize_admin_url(&admin_url)?;
    let instance_id = instance_id.trim();
    if instance_id.is_empty() {
        return Err(OmniError::invalid_input("请选择 Java 服务实例"));
    }
    let proxy = state.proxy_config.lock().await.clone();
    let client = build_http_client_for_url(&base, &proxy, REQUEST_TIMEOUT)
        .map_err(map_http_client_err)?;

    let memory_url = instance_actuator_url(
        &base,
        instance_id,
        &format!(
            "jolokia/read/{}",
            urlencoding::encode("java.lang:type=Memory")
        ),
    );
    let threading_url = instance_actuator_url(
        &base,
        instance_id,
        &format!(
            "jolokia/read/{}",
            urlencoding::encode("java.lang:type=Threading")
        ),
    );

    let (mem_json, thr_json) = tokio::join!(
        get_json(&client, &memory_url),
        get_json(&client, &threading_url),
    );

    let mut snapshot = SbaJvmSnapshot {
        threads_live: None,
        threads_daemon: None,
        threads_peak: None,
        heap_used: None,
        heap_committed: None,
        heap_max: None,
        non_heap_used: None,
        non_heap_committed: None,
        non_heap_max: None,
        non_heap_init: None,
    };
    if let Ok(json) = mem_json {
        if let Some(mem) = parse_jmx_memory(&json) {
            snapshot = merge_snapshot(snapshot, mem);
        }
    }
    if let Ok(json) = thr_json {
        if let Some((live, daemon, peak)) = parse_jmx_threads(&json) {
            snapshot.threads_live = snapshot.threads_live.or(live);
            snapshot.threads_daemon = snapshot.threads_daemon.or(daemon);
            snapshot.threads_peak = snapshot.threads_peak.or(peak);
        }
    }

    let need_metrics = snapshot.heap_used.is_none()
        || snapshot.threads_live.is_none()
        || snapshot.non_heap_used.is_none();
    if !need_metrics {
        return Ok(snapshot);
    }

    let (
        threads_live,
        threads_daemon,
        threads_peak,
        heap_used,
        heap_committed,
        heap_max,
        non_heap_used,
        non_heap_committed,
        non_heap_max,
    ) = tokio::join!(
        fetch_metric(&client, &base, instance_id, "jvm.threads.live", None),
        fetch_metric(&client, &base, instance_id, "jvm.threads.daemon", None),
        fetch_metric(&client, &base, instance_id, "jvm.threads.peak", None),
        fetch_metric(&client, &base, instance_id, "jvm.memory.used", Some("area:heap")),
        fetch_metric(
            &client,
            &base,
            instance_id,
            "jvm.memory.committed",
            Some("area:heap")
        ),
        fetch_metric(&client, &base, instance_id, "jvm.memory.max", Some("area:heap")),
        fetch_metric(
            &client,
            &base,
            instance_id,
            "jvm.memory.used",
            Some("area:nonheap")
        ),
        fetch_metric(
            &client,
            &base,
            instance_id,
            "jvm.memory.committed",
            Some("area:nonheap")
        ),
        fetch_metric(
            &client,
            &base,
            instance_id,
            "jvm.memory.max",
            Some("area:nonheap")
        ),
    );

    Ok(merge_snapshot(
        snapshot,
        SbaJvmSnapshot {
            threads_live,
            threads_daemon,
            threads_peak,
            heap_used,
            heap_committed,
            heap_max,
            non_heap_used,
            non_heap_committed,
            non_heap_max,
            non_heap_init: None,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn metric_value_reads_value_statistic() {
        let json = json!({
            "name": "jvm.memory.used",
            "measurements": [
                { "statistic": "VALUE", "value": 272629760.0 }
            ]
        });
        assert_eq!(metric_value(&json), Some(272629760.0));
    }

    #[test]
    fn parse_instances_from_array() {
        let json = json!([{
            "name": "agent-server",
            "status": "UP",
            "instances": [{
                "id": "abc123",
                "status": "UP",
                "registration": { "name": "agent-server" }
            }]
        }]);
        let list = parse_instances(&json);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "abc123");
        assert_eq!(list[0].application, "agent-server");
    }

    #[test]
    fn parse_jmx_memory_reads_init() {
        let json = json!({
            "value": {
                "HeapMemoryUsage": {
                    "init": 536870912,
                    "used": 272629760,
                    "committed": 562036736,
                    "max": 562036736
                },
                "NonHeapMemoryUsage": {
                    "init": 157286400,
                    "used": 242221056,
                    "committed": 250609664,
                    "max": 1426063360
                }
            }
        });
        let snap = parse_jmx_memory(&json).expect("memory");
        assert_eq!(snap.heap_used, Some(272629760.0));
        assert_eq!(snap.non_heap_init, Some(157286400.0));
    }

    #[test]
    fn normalize_admin_url_adds_http() {
        let url = normalize_admin_url("127.0.0.1:8080/sba").unwrap();
        assert_eq!(url, "http://127.0.0.1:8080/sba");
    }
}
