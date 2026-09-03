//! 弹性公网 IP。

use std::collections::BTreeMap;

use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::CloudAction;

#[derive(Debug, Clone, Default)]
pub struct CloudEip {
    pub allocation_id: String,
    pub ip: String,
    pub status: String,
    pub region_id: String,
    pub bandwidth: String,
    pub instance_id: String,
    pub instance_type: String,
    pub charge_type: String,
    pub name: String,
}

fn vpc_endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://vpc.{region}.aliyuncs.com/"))
}

fn parse_eip(item: &Value, region: &str) -> CloudEip {
    CloudEip {
        allocation_id: str_field(item, &["AllocationId"]),
        ip: str_field(item, &["IpAddress"]),
        status: str_field(item, &["Status"]),
        region_id: {
            let id = str_field(item, &["RegionId"]);
            if id.is_empty() {
                region.to_string()
            } else {
                id
            }
        },
        bandwidth: str_field(item, &["Bandwidth"]),
        instance_id: str_field(item, &["InstanceId"]),
        instance_type: str_field(item, &["InstanceType"]),
        charge_type: str_field(item, &["ChargeType", "InternetChargeType"]),
        name: str_field(item, &["Name", "AllocationId"]),
    }
}

impl AliyunCredentials {
    pub async fn list_eips(&self, http: &Client) -> Result<Vec<CloudEip>, OmniError> {
        let region = self.region.trim();
        let endpoint = vpc_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            let body = self
                .rpc_call(http, &endpoint, "2016-04-28", "DescribeEipAddresses", params)
                .await?;
            let items = json_list(&body, "EipAddresses", "EipAddress");
            let count = items.len();
            out.extend(items.iter().map(|item| parse_eip(item, region)));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_eip(&self, http: &Client, id: &str) -> Result<CloudEip, OmniError> {
        let region = self.region.trim();
        let endpoint = vpc_endpoint(region)?;
        let id = id.trim();
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        if id.contains('.') {
            params.insert("EipAddress".into(), id.to_string());
        } else {
            params.insert("AllocationId".into(), id.to_string());
        }
        let body = self
            .rpc_call(http, &endpoint, "2016-04-28", "DescribeEipAddresses", params)
            .await?;
        json_list(&body, "EipAddresses", "EipAddress")
            .first()
            .map(|item| parse_eip(item, region))
            .ok_or_else(|| OmniError::not_found(format!("未找到 EIP: {id}")))
    }

    pub async fn associate_eip(&self, http: &Client, action: &CloudAction) -> Result<(), OmniError> {
        let instance_id = action.param("instanceId");
        if instance_id.is_empty() {
            return Err(OmniError::invalid_input("缺少要绑定的实例 id"));
        }
        let region = self.region.trim();
        let endpoint = vpc_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("AllocationId".into(), action.resource_id.trim().to_string());
        params.insert("InstanceId".into(), instance_id);
        params.insert(
            "InstanceType".into(),
            if action.param("instanceType").is_empty() {
                "EcsInstance".into()
            } else {
                action.param("instanceType")
            },
        );
        let _ = self
            .rpc_call(http, &endpoint, "2016-04-28", "AssociateEipAddress", params)
            .await?;
        Ok(())
    }

    pub async fn unassociate_eip(&self, http: &Client, action: &CloudAction) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = vpc_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("AllocationId".into(), action.resource_id.trim().to_string());
        if let Some(id) = nonempty(action.param("instanceId")) {
            params.insert("InstanceId".into(), id);
        }
        let _ = self
            .rpc_call(http, &endpoint, "2016-04-28", "UnassociateEipAddress", params)
            .await?;
        Ok(())
    }

    pub async fn modify_eip_bandwidth(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let bandwidth = action.param("bandwidth");
        if bandwidth.is_empty() {
            return Err(OmniError::invalid_input("请填写带宽"));
        }
        let region = self.region.trim();
        let endpoint = vpc_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("AllocationId".into(), action.resource_id.trim().to_string());
        params.insert("Bandwidth".into(), bandwidth);
        let _ = self
            .rpc_call(
                http,
                &endpoint,
                "2016-04-28",
                "ModifyEipAddressAttribute",
                params,
            )
            .await?;
        Ok(())
    }
}

fn nonempty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}
