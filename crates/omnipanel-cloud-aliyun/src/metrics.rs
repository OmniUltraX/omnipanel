//! 云监控 CMS：ECS / 轻量 / RDS 时序。

use std::collections::BTreeMap;

use chrono::{TimeZone, Utc};
use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::AliyunCredentials;
use crate::types::{
    CloudMetricPoint, CloudMetricQuery, CloudMetricSeries, CAP_COMPUTE, CAP_COMPUTE_LITE,
    CAP_DATABASE, CAP_DATABASE_CACHE, CAP_LOAD_BALANCER, CAP_NETWORK_EIP,
};

pub const ECS_METRIC_IDS: &[&str] = &[
    "CPUUtilization",
    "memory_usedutilization",
    "load_1m",
    "net_tcpconnection",
    "InternetInRate",
    "InternetOutRate",
    "IntranetInRate",
    "IntranetOutRate",
    "DiskReadBPS",
    "DiskWriteBPS",
    "DiskReadIOPS",
    "DiskWriteIOPS",
];

pub const SWAS_METRIC_IDS: &[&str] = &[
    "CPUUtilization",
    "memory_usedutilization",
    "InternetInRate",
    "InternetOutRate",
    "DiskReadBPS",
    "DiskWriteBPS",
];

pub const RDS_METRIC_IDS: &[&str] = &[
    "CpuUsage",
    "MemoryUsage",
    "DiskUsage",
    "ConnectionUsage",
    "IOPSUsage",
    "MySQL_SlowQueries",
];

pub const KV_METRIC_IDS: &[&str] = &[
    "CpuUsage",
    "MemoryUsage",
    "ConnectionUsage",
    "IntranetIn",
    "IntranetOut",
];

pub const SLB_METRIC_IDS: &[&str] = &[
    "ActiveConnection",
    "UnhealthyServerCount",
    "TrafficTX",
    "TrafficRX",
];

pub const EIP_METRIC_IDS: &[&str] = &["net_rx.rate", "net_tx.rate"];

pub fn default_metric_ids(capability: &str) -> &'static [&'static str] {
    match capability.trim() {
        CAP_COMPUTE => ECS_METRIC_IDS,
        CAP_COMPUTE_LITE => SWAS_METRIC_IDS,
        CAP_DATABASE => RDS_METRIC_IDS,
        CAP_DATABASE_CACHE => KV_METRIC_IDS,
        CAP_LOAD_BALANCER => SLB_METRIC_IDS,
        CAP_NETWORK_EIP => EIP_METRIC_IDS,
        _ => &[],
    }
}

fn metric_namespace(capability: &str) -> Option<&'static str> {
    match capability.trim() {
        CAP_COMPUTE => Some("acs_ecs_dashboard"),
        CAP_COMPUTE_LITE => Some("acs_swas"),
        CAP_DATABASE => Some("acs_rds_dashboard"),
        CAP_DATABASE_CACHE => Some("acs_kvstore"),
        CAP_LOAD_BALANCER => Some("acs_slb"),
        CAP_NETWORK_EIP => Some("acs_vpc_eip"),
        _ => None,
    }
}

fn metric_unit(id: &str) -> &'static str {
    match id {
        "CPUUtilization" | "memory_usedutilization" | "CpuUsage" | "MemoryUsage" | "DiskUsage"
        | "ConnectionUsage" | "IOPSUsage" => "%",
        "InternetInRate" | "InternetOutRate" | "IntranetIn" | "IntranetOut" | "IntranetInRate"
        | "IntranetOutRate" | "TrafficTX" | "TrafficRX" | "net_rx.rate" | "net_tx.rate" => "bps",
        "DiskReadBPS" | "DiskWriteBPS" => "B/s",
        "DiskReadIOPS" | "DiskWriteIOPS" => "IOPS",
        "MySQL_SlowQueries" | "ActiveConnection" | "UnhealthyServerCount" | "net_tcpconnection" => {
            "count"
        }
        _ => "",
    }
}

fn metric_label(id: &str) -> String {
    match id {
        "CPUUtilization" | "CpuUsage" => "CPU".into(),
        "memory_usedutilization" | "MemoryUsage" => "内存".into(),
        "DiskUsage" => "磁盘".into(),
        "ConnectionUsage" => "连接".into(),
        "IOPSUsage" => "IOPS".into(),
        "InternetInRate" => "公网入".into(),
        "InternetOutRate" => "公网出".into(),
        "IntranetIn" | "IntranetInRate" => "内网入".into(),
        "IntranetOut" | "IntranetOutRate" => "内网出".into(),
        "DiskReadBPS" => "磁盘读".into(),
        "DiskWriteBPS" => "磁盘写".into(),
        "DiskReadIOPS" => "磁盘读 IOPS".into(),
        "DiskWriteIOPS" => "磁盘写 IOPS".into(),
        "load_1m" => "1 分钟负载".into(),
        "net_tcpconnection" => "TCP 连接数".into(),
        "MySQL_SlowQueries" => "慢查询".into(),
        "ActiveConnection" => "活跃连接".into(),
        "UnhealthyServerCount" => "不健康后端".into(),
        "TrafficTX" => "出流量".into(),
        "TrafficRX" => "入流量".into(),
        "net_rx.rate" => "入带宽".into(),
        "net_tx.rate" => "出带宽".into(),
        _ => id.to_string(),
    }
}

fn needs_guest_os_agent(metric_id: &str) -> bool {
    matches!(
        metric_id,
        "memory_usedutilization" | "load_1m" | "load_5m" | "load_15m" | "net_tcpconnection"
    )
}

/// CMS 维度：TCP 连接必须带 state，否则 Datapoints 为空。
fn metric_dimensions(metric_id: &str, instance_id: &str) -> String {
    let id = instance_id.trim();
    if metric_id == "net_tcpconnection" {
        serde_json::json!([{ "instanceId": id, "state": "TCP_TOTAL" }]).to_string()
    } else {
        serde_json::json!([{ "instanceId": id }]).to_string()
    }
}

fn fallback_dimensions(metric_id: &str, instance_id: &str) -> Vec<String> {
    let id = instance_id.trim();
    if metric_id == "net_tcpconnection" {
        vec![
            serde_json::json!([{ "instanceId": id, "state": "ESTABLISHED" }]).to_string(),
            serde_json::json!([{ "instanceId": id }]).to_string(),
            serde_json::json!({ "instanceId": id, "state": "TCP_TOTAL" }).to_string(),
        ]
    } else {
        vec![serde_json::json!({ "instanceId": id }).to_string()]
    }
}

fn format_cms_time(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "1970-01-01 00:00:00".into())
}

fn parse_datapoints(raw: &Value) -> Vec<CloudMetricPoint> {
    let arr = if let Some(s) = raw.as_str() {
        serde_json::from_str::<Value>(s).unwrap_or(Value::Null)
    } else {
        raw.clone()
    };
    let items = arr.as_array().cloned().unwrap_or_default();
    let mut points: Vec<CloudMetricPoint> = items
        .iter()
        .filter_map(|item| {
            let ts = item
                .get("timestamp")
                .or_else(|| item.get("Timestamp"))
                .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)))
                .unwrap_or(0);
            let value = item
                .get("Average")
                .or_else(|| item.get("Value"))
                .or_else(|| item.get("Maximum"))
                .and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_i64().map(|n| n as f64))
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })?;
            if ts <= 0 {
                return None;
            }
            Some(CloudMetricPoint { ts_ms: ts, value })
        })
        .collect();
    points.sort_by_key(|p| p.ts_ms);
    points
}

impl AliyunCredentials {
    pub async fn get_metrics(
        &self,
        http: &Client,
        capability: &str,
        resource_id: &str,
        query: &CloudMetricQuery,
    ) -> Result<Vec<CloudMetricSeries>, OmniError> {
        let namespace = metric_namespace(capability).ok_or_else(|| {
            OmniError::invalid_input(format!("该能力不支持监控: {capability}"))
        })?;
        let region = self.region.trim();
        if region.is_empty() {
            return Err(OmniError::invalid_input("请先配置 Region"));
        }
        let now = Utc::now().timestamp_millis();
        let end_ms = if query.end_ms > 0 { query.end_ms } else { now };
        let start_ms = if query.start_ms > 0 {
            query.start_ms
        } else {
            end_ms - 3600_000
        };
        let period = if query.period_sec > 0 {
            query.period_sec
        } else {
            60
        };
        let ids: Vec<String> = if query.metric_ids.is_empty() {
            default_metric_ids(capability)
                .iter()
                .map(|s| (*s).to_string())
                .collect()
        } else {
            query.metric_ids.clone()
        };
        let endpoint = format!("https://metrics.{region}.aliyuncs.com/");
        let instance_id = resource_id.trim().to_string();
        let futs = ids.into_iter().map(|id| {
            let endpoint = endpoint.clone();
            let instance_id = instance_id.clone();
            async move {
                let mut points = self
                    .query_cms_points(
                        http,
                        &endpoint,
                        namespace,
                        &id,
                        &metric_dimensions(&id, &instance_id),
                        start_ms,
                        end_ms,
                        period,
                        "DescribeMetricList",
                    )
                    .await;
                if points.is_empty() && needs_guest_os_agent(&id) {
                    for dims in fallback_dimensions(&id, &instance_id) {
                        points = self
                            .query_cms_points(
                                http,
                                &endpoint,
                                namespace,
                                &id,
                                &dims,
                                start_ms,
                                end_ms,
                                period,
                                "DescribeMetricList",
                            )
                            .await;
                        if !points.is_empty() {
                            break;
                        }
                        points = self
                            .query_cms_points(
                                http,
                                &endpoint,
                                namespace,
                                &id,
                                &dims,
                                start_ms,
                                end_ms,
                                period,
                                "DescribeMetricData",
                            )
                            .await;
                        if !points.is_empty() {
                            break;
                        }
                    }
                }
                CloudMetricSeries {
                    id: id.clone(),
                    label: metric_label(&id),
                    unit: metric_unit(&id).to_string(),
                    points,
                }
            }
        });
        Ok(futures::future::join_all(futs).await)
    }

    async fn query_cms_points(
        &self,
        http: &Client,
        endpoint: &str,
        namespace: &str,
        metric_id: &str,
        dimensions: &str,
        start_ms: i64,
        end_ms: i64,
        period: i64,
        action: &str,
    ) -> Vec<CloudMetricPoint> {
        let mut params = BTreeMap::new();
        params.insert("Namespace".into(), namespace.to_string());
        params.insert("MetricName".into(), metric_id.to_string());
        params.insert("Dimensions".into(), dimensions.to_string());
        params.insert("StartTime".into(), format_cms_time(start_ms));
        params.insert("EndTime".into(), format_cms_time(end_ms));
        params.insert("Period".into(), period.to_string());
        params.insert("Length".into(), "1440".into());
        match self
            .rpc_call(http, endpoint, "2019-01-01", action, params)
            .await
        {
            Ok(body) => parse_datapoints(body.get("Datapoints").unwrap_or(&Value::Null)),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_string_datapoints() {
        let raw = json!("[{\"timestamp\":1700000000000,\"Average\":12.5},{\"timestamp\":1700000060000,\"Average\":20}]");
        let points = parse_datapoints(&raw);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].value, 12.5);
        assert_eq!(points[1].ts_ms, 1700000060000);
    }

    #[test]
    fn tcp_dimensions_require_state() {
        let dims = metric_dimensions("net_tcpconnection", "i-1");
        assert!(dims.contains("TCP_TOTAL"));
        assert!(dims.contains("instanceId"));
        let cpu = metric_dimensions("CPUUtilization", "i-1");
        assert!(!cpu.contains("state"));
        assert!(needs_guest_os_agent("memory_usedutilization"));
        assert!(!needs_guest_os_agent("CPUUtilization"));
    }
}
