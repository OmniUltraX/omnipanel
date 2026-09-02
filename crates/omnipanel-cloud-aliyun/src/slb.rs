//! 传统型负载均衡 SLB。

use std::collections::BTreeMap;

use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::{CloudAction, CloudChildRow};

#[derive(Debug, Clone, Default)]
pub struct CloudLoadBalancer {
    pub id: String,
    pub name: String,
    pub status: String,
    pub region_id: String,
    pub address: String,
    pub address_type: String,
    pub spec: String,
    pub vpc_id: String,
    pub bandwidth: String,
    pub listeners: Vec<CloudChildRow>,
    pub backends: Vec<CloudChildRow>,
}

fn slb_endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://slb.{region}.aliyuncs.com/"))
}

fn fields(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

fn parse_lb(item: &Value, region: &str) -> CloudLoadBalancer {
    CloudLoadBalancer {
        id: str_field(item, &["LoadBalancerId"]),
        name: str_field(item, &["LoadBalancerName", "LoadBalancerId"]),
        status: str_field(item, &["LoadBalancerStatus"]),
        region_id: {
            let id = str_field(item, &["RegionId"]);
            if id.is_empty() {
                region.to_string()
            } else {
                id
            }
        },
        address: str_field(item, &["Address"]),
        address_type: str_field(item, &["AddressType"]),
        spec: str_field(item, &["LoadBalancerSpec"]),
        vpc_id: str_field(item, &["VpcId"]),
        bandwidth: str_field(item, &["Bandwidth"]),
        listeners: Vec::new(),
        backends: Vec::new(),
    }
}

impl AliyunCredentials {
    pub async fn list_load_balancers(&self, http: &Client) -> Result<Vec<CloudLoadBalancer>, OmniError> {
        let region = self.region.trim();
        let endpoint = slb_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            let body = self
                .rpc_call(http, &endpoint, "2014-05-15", "DescribeLoadBalancers", params)
                .await?;
            let items = json_list(&body, "LoadBalancers", "LoadBalancer");
            let count = items.len();
            out.extend(items.iter().map(|item| parse_lb(item, region)));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_load_balancer(
        &self,
        http: &Client,
        lb_id: &str,
    ) -> Result<CloudLoadBalancer, OmniError> {
        let region = self.region.trim();
        let endpoint = slb_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("LoadBalancerId".into(), lb_id.trim().to_string());
        let body = self
            .rpc_call(
                http,
                &endpoint,
                "2014-05-15",
                "DescribeLoadBalancerAttribute",
                params,
            )
            .await?;
        let mut item = parse_lb(&body, region);
        if item.id.is_empty() {
            item.id = lb_id.trim().to_string();
        }
        item.listeners = json_list(&body, "ListenerPortsAndProtocol", "ListenerPortAndProtocol")
            .iter()
            .map(|row| CloudChildRow {
                id: format!(
                    "{}:{}",
                    str_field(row, &["ListenerProtocol"]),
                    str_field(row, &["ListenerPort"])
                ),
                kind: "listener".into(),
                name: format!(
                    "{}:{}",
                    str_field(row, &["ListenerProtocol"]),
                    str_field(row, &["ListenerPort"])
                ),
                status: str_field(row, &["Status"]),
                fields: fields(&[
                    ("protocol", str_field(row, &["ListenerProtocol"])),
                    ("port", str_field(row, &["ListenerPort"])),
                    ("bandwidth", str_field(row, &["ListenerBandwidth"])),
                ]),
            })
            .collect();
        item.backends = json_list(&body, "BackendServers", "BackendServer")
            .iter()
            .map(|row| CloudChildRow {
                id: str_field(row, &["ServerId"]),
                kind: "backend".into(),
                name: str_field(row, &["ServerId"]),
                status: str_field(row, &["ServerHealthStatus", "Type"]),
                fields: fields(&[
                    ("weight", str_field(row, &["Weight"])),
                    ("port", str_field(row, &["Port"])),
                    ("type", str_field(row, &["Type"])),
                ]),
            })
            .collect();
        Ok(item)
    }

    pub async fn set_load_balancer_status(
        &self,
        http: &Client,
        lb_id: &str,
        status: &str,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = slb_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("LoadBalancerId".into(), lb_id.trim().to_string());
        params.insert("LoadBalancerStatus".into(), status.to_string());
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-15", "SetLoadBalancerStatus", params)
            .await?;
        Ok(())
    }

    pub async fn set_listener_status(
        &self,
        http: &Client,
        action: &CloudAction,
        start: bool,
    ) -> Result<(), OmniError> {
        let port = action.param("port");
        if port.is_empty() {
            return Err(OmniError::invalid_input("缺少监听端口"));
        }
        let region = self.region.trim();
        let endpoint = slb_endpoint(region)?;
        let api = if start {
            "StartLoadBalancerListener"
        } else {
            "StopLoadBalancerListener"
        };
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("LoadBalancerId".into(), action.resource_id.trim().to_string());
        params.insert("ListenerPort".into(), port);
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-15", api, params)
            .await?;
        Ok(())
    }
}
