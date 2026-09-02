//! ECS 安全组 + 轻量防火墙规则。

use std::collections::BTreeMap;

use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_arr, json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::{CloudAction, CloudNetworkRule};

#[derive(Debug, Clone, Default)]
pub struct CloudSecurityGroup {
    pub group_id: String,
    pub name: String,
    pub vpc_id: String,
    pub description: String,
    pub region_id: String,
    pub creation_time: String,
    pub instance_count: String,
    pub rules: Vec<CloudNetworkRule>,
}

fn ecs_endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://ecs.{region}.aliyuncs.com/"))
}

fn swas_endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://swas.{region}.aliyuncs.com/"))
}

fn parse_security_group(item: &Value, region: &str) -> CloudSecurityGroup {
    CloudSecurityGroup {
        group_id: str_field(item, &["SecurityGroupId"]),
        name: str_field(item, &["SecurityGroupName"]),
        vpc_id: str_field(item, &["VpcId"]),
        description: str_field(item, &["Description"]),
        region_id: {
            let id = str_field(item, &["RegionId"]);
            if id.is_empty() {
                region.to_string()
            } else {
                id
            }
        },
        creation_time: str_field(item, &["CreationTime"]),
        instance_count: str_field(item, &["EcsCount", "InstanceCount"]),
        rules: Vec::new(),
    }
}

fn parse_sg_rule(item: &Value) -> CloudNetworkRule {
    let direction = str_field(item, &["Direction"]).to_ascii_lowercase();
    let cidr = str_field(
        item,
        &[
            "SourceCidrIp",
            "DestCidrIp",
            "Ipv6SourceCidrIp",
            "Ipv6DestCidrIp",
        ],
    );
    CloudNetworkRule {
        id: str_field(item, &["SecurityGroupRuleId"]),
        direction: if direction.is_empty() {
            "ingress".into()
        } else {
            direction
        },
        protocol: str_field(item, &["IpProtocol"]).to_ascii_lowercase(),
        port_range: str_field(item, &["PortRange"]),
        cidr,
        source_group_id: str_field(item, &["SourceGroupId", "DestGroupId"]),
        policy: str_field(item, &["Policy"]).to_ascii_lowercase(),
        priority: str_field(item, &["Priority"]),
        nic_type: str_field(item, &["NicType"]),
        description: str_field(item, &["Description"]),
    }
}

fn parse_swas_rule(item: &Value) -> CloudNetworkRule {
    CloudNetworkRule {
        id: str_field(item, &["RuleId"]),
        direction: "ingress".into(),
        protocol: str_field(item, &["RuleProtocol"]).to_ascii_lowercase(),
        port_range: str_field(item, &["Port"]),
        cidr: str_field(item, &["SourceCidrIp"]),
        source_group_id: String::new(),
        policy: str_field(item, &["Policy"]).to_ascii_lowercase(),
        priority: String::new(),
        nic_type: "internet".into(),
        description: str_field(item, &["Remark"]),
    }
}

impl AliyunCredentials {
    pub async fn list_security_groups(
        &self,
        http: &Client,
    ) -> Result<Vec<CloudSecurityGroup>, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            let body = self
                .rpc_call(http, &endpoint, "2014-05-26", "DescribeSecurityGroups", params)
                .await?;
            let items = json_list(&body, "SecurityGroups", "SecurityGroup");
            let count = items.len();
            out.extend(items.iter().map(|item| parse_security_group(item, region)));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_security_group(
        &self,
        http: &Client,
        group_id: &str,
    ) -> Result<CloudSecurityGroup, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("SecurityGroupId".into(), group_id.trim().to_string());
        let body = self
            .rpc_call(
                http,
                &endpoint,
                "2014-05-26",
                "DescribeSecurityGroupAttribute",
                params,
            )
            .await?;
        let mut group = parse_security_group(&body, region);
        if group.group_id.is_empty() {
            group.group_id = group_id.trim().to_string();
        }
        if group.name.is_empty() {
            group.name = str_field(&body, &["SecurityGroupName"]);
        }
        group.rules = json_list(&body, "Permissions", "Permission")
            .iter()
            .map(parse_sg_rule)
            .collect();
        Ok(group)
    }

    pub async fn list_security_group_instances(
        &self,
        http: &Client,
        group_id: &str,
    ) -> Result<Vec<(String, String)>, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("SecurityGroupId".into(), group_id.trim().to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            let body = self
                .rpc_call(http, &endpoint, "2014-05-26", "DescribeInstances", params)
                .await?;
            let instances = json_arr(&body, &["Instances", "Instance"]);
            for item in &instances {
                let id = str_field(item, &["InstanceId"]);
                if id.is_empty() {
                    continue;
                }
                let name = str_field(item, &["InstanceName"]);
                out.push((id, name));
            }
            let total = json_total_count(&body);
            if instances.is_empty() || (total > 0 && out.len() as u64 >= total) || page >= 10 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn list_swas_firewall_rules(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudNetworkRule>, OmniError> {
        let region = self.region.trim();
        let endpoint = swas_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(http, &endpoint, "2020-06-01", "ListFirewallRules", params)
            .await?;
        Ok(json_list(&body, "FirewallRules", "FirewallRule")
            .iter()
            .map(parse_swas_rule)
            .collect())
    }

    pub async fn authorize_security_group_rule(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let direction = action.param("direction").to_ascii_lowercase();
        let api = if direction == "egress" {
            "AuthorizeSecurityGroupEgress"
        } else {
            "AuthorizeSecurityGroup"
        };
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("SecurityGroupId".into(), action.resource_id.trim().to_string());
        params.insert(
            "IpProtocol".into(),
            nonempty_or(action.param("protocol").to_ascii_uppercase(), "TCP"),
        );
        params.insert(
            "PortRange".into(),
            nonempty_or(action.param("portRange"), "-1/-1"),
        );
        params.insert("Policy".into(), nonempty_or(action.param("policy"), "accept"));
        params.insert("NicType".into(), nonempty_or(action.param("nicType"), "intranet"));
        if let Some(prio) = nonempty_opt(action.param("priority")) {
            params.insert("Priority".into(), prio);
        }
        if let Some(desc) = nonempty_opt(action.param("description")) {
            params.insert("Description".into(), desc);
        }
        let cidr = nonempty_or(action.param("cidr"), "0.0.0.0/0");
        if direction == "egress" {
            params.insert("DestCidrIp".into(), cidr);
        } else {
            params.insert("SourceCidrIp".into(), cidr);
        }
        if let Some(src_group) = nonempty_opt(action.param("sourceGroupId")) {
            if direction == "egress" {
                params.insert("DestGroupId".into(), src_group);
            } else {
                params.insert("SourceGroupId".into(), src_group);
            }
        }
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", api, params)
            .await?;
        Ok(())
    }

    pub async fn revoke_security_group_rule(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let direction = action.param("direction").to_ascii_lowercase();
        let api = if direction == "egress" {
            "RevokeSecurityGroupEgress"
        } else {
            "RevokeSecurityGroup"
        };
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("SecurityGroupId".into(), action.resource_id.trim().to_string());
        if let Some(rule_id) = nonempty_opt(action.param("ruleId")) {
            params.insert("SecurityGroupRuleId.1".into(), rule_id);
        } else {
            params.insert(
                "IpProtocol".into(),
                nonempty_or(action.param("protocol").to_ascii_uppercase(), "TCP"),
            );
            params.insert(
                "PortRange".into(),
                nonempty_or(action.param("portRange"), "-1/-1"),
            );
            params.insert("NicType".into(), nonempty_or(action.param("nicType"), "intranet"));
            let cidr = action.param("cidr");
            if !cidr.is_empty() {
                if direction == "egress" {
                    params.insert("DestCidrIp".into(), cidr);
                } else {
                    params.insert("SourceCidrIp".into(), cidr);
                }
            }
        }
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", api, params)
            .await?;
        Ok(())
    }

    pub async fn authorize_swas_firewall_rule(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = swas_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), action.resource_id.trim().to_string());
        params.insert(
            "RuleProtocol".into(),
            nonempty_or(action.param("protocol").to_ascii_uppercase(), "TCP"),
        );
        params.insert("Port".into(), nonempty_or(action.param("portRange"), "22"));
        params.insert(
            "SourceCidrIp".into(),
            nonempty_or(action.param("cidr"), "0.0.0.0/0"),
        );
        if let Some(remark) = nonempty_opt(action.param("description")) {
            params.insert("Remark".into(), remark);
        }
        let _ = self
            .rpc_call(http, &endpoint, "2020-06-01", "CreateFirewallRule", params)
            .await?;
        Ok(())
    }

    pub async fn join_security_group(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let group_id = action.param("securityGroupId");
        if group_id.is_empty() {
            return Err(OmniError::invalid_input("缺少安全组 id"));
        }
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), action.resource_id.trim().to_string());
        params.insert("SecurityGroupId".into(), group_id);
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", "JoinSecurityGroup", params)
            .await?;
        Ok(())
    }

    pub async fn leave_security_group(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let group_id = action.param("securityGroupId");
        if group_id.is_empty() {
            return Err(OmniError::invalid_input("缺少安全组 id"));
        }
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), action.resource_id.trim().to_string());
        params.insert("SecurityGroupId".into(), group_id);
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", "LeaveSecurityGroup", params)
            .await?;
        Ok(())
    }

    pub async fn revoke_swas_firewall_rule(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = swas_endpoint(region)?;
        let rule_id = action.param("ruleId");
        if rule_id.is_empty() {
            return Err(OmniError::invalid_input("缺少防火墙规则 id"));
        }
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), action.resource_id.trim().to_string());
        params.insert("RuleId".into(), rule_id);
        let _ = self
            .rpc_call(http, &endpoint, "2020-06-01", "DeleteFirewallRule", params)
            .await?;
        Ok(())
    }
}

fn nonempty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn nonempty_opt(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_ingress_rule() {
        let item = json!({
            "SecurityGroupRuleId": "sgr-1",
            "Direction": "ingress",
            "IpProtocol": "TCP",
            "PortRange": "22/22",
            "SourceCidrIp": "0.0.0.0/0",
            "Policy": "Accept",
            "Priority": "1",
            "NicType": "intranet",
            "Description": "ssh"
        });
        let rule = parse_sg_rule(&item);
        assert_eq!(rule.id, "sgr-1");
        assert_eq!(rule.direction, "ingress");
        assert_eq!(rule.port_range, "22/22");
        assert_eq!(rule.cidr, "0.0.0.0/0");
        assert_eq!(rule.policy, "accept");
    }

    #[test]
    fn parses_security_group_instance_count() {
        let item = json!({
            "SecurityGroupId": "sg-1",
            "SecurityGroupName": "web",
            "VpcId": "vpc-1",
            "Description": "prod",
            "RegionId": "cn-hangzhou",
            "CreationTime": "2024-01-01T00:00:00Z",
            "EcsCount": "3"
        });
        let group = parse_security_group(&item, "cn-hangzhou");
        assert_eq!(group.group_id, "sg-1");
        assert_eq!(group.instance_count, "3");
    }
}
