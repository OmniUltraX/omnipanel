//! 腾讯云 TC3-HMAC-SHA256 JSON 客户端与 COS q-sign。

use chrono::{TimeZone, Utc};
use hmac::{Hmac, Mac};
use omnipanel_cloud_aliyun::{AliyunCredentials, CloudAction, CloudLogQuery};
use omnipanel_error::{ErrorCode, OmniError};
use reqwest::Client;
use serde_json::{json, Value};
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::Sha256;

use crate::DEFAULT_REGION;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

const PAGE_LIMIT: u64 = 100;
const PAGE_MAX: u64 = 500;

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(<Sha256 as sha2::Digest>::digest(data))
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, OmniError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "HMAC 初始化失败").with_cause(e.to_string())
    })?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hmac_sha1_raw(key: &[u8], data: &[u8]) -> Result<Vec<u8>, OmniError> {
    let mut mac = HmacSha1::new_from_slice(key).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "HMAC-SHA1 初始化失败").with_cause(e.to_string())
    })?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

pub fn jstr(v: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(|x| x.as_str()) {
            return s.to_string();
        }
        if let Some(n) = v.get(*key).and_then(|x| x.as_i64()) {
            return n.to_string();
        }
        if let Some(n) = v.get(*key).and_then(|x| x.as_u64()) {
            return n.to_string();
        }
        if let Some(n) = v.get(*key).and_then(|x| x.as_f64()) {
            if n.fract() == 0.0 {
                return format!("{}", n as i64);
            }
            return n.to_string();
        }
        if let Some(b) = v.get(*key).and_then(|x| x.as_bool()) {
            return b.to_string();
        }
    }
    String::new()
}

pub fn jarr(v: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        if let Some(arr) = v.get(*key).and_then(|x| x.as_array()) {
            return arr.clone();
        }
        if let Some(obj) = v.get(*key).and_then(|x| x.as_object()) {
            for nested in [
                "Instance",
                "Item",
                "Items",
                "Domain",
                "Certificate",
                "Region",
                "Record",
                "Listener",
                "Target",
                "Disk",
                "Snapshot",
                "Address",
                "LoadBalancer",
                "SecurityGroup",
                "Group",
            ] {
                if let Some(arr) = obj.get(nested).and_then(|x| x.as_array()) {
                    return arr.clone();
                }
                if let Some(one) = obj.get(nested) {
                    if one.is_null() || one.as_object().is_some_and(|o| o.is_empty()) {
                        continue;
                    }
                    return vec![one.clone()];
                }
            }
        }
    }
    Vec::new()
}

/// 读取公网/内网 IP 数组或嵌套对象。
pub fn jips(v: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(arr) = v.get(*key).and_then(|x| x.as_array()) {
            let joined: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| item.get("Ip").and_then(|x| x.as_str()).map(str::to_string))
                        .or_else(|| {
                            item.get("AddressIp")
                                .and_then(|x| x.as_str())
                                .map(str::to_string)
                        })
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !joined.is_empty() {
                return joined.join(",");
            }
        }
        let direct = jstr(v, &[key]);
        if !direct.is_empty() {
            return direct;
        }
    }
    String::new()
}

pub fn parse_error_json(body: &Value) -> Option<(String, String)> {
    let err = body
        .get("Response")
        .and_then(|r| r.get("Error"))
        .or_else(|| body.get("Error"))?;
    let code = jstr(err, &["Code"]);
    let message = jstr(err, &["Message"]);
    if code.is_empty() && message.is_empty() {
        return None;
    }
    Some((code, message))
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

fn collect_xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        if let Some(end) = after.find(&close) {
            out.push(&after[..end]);
            rest = &after[end + close.len()..];
        } else {
            break;
        }
    }
    out
}

pub fn region_or_default(creds: &AliyunCredentials) -> String {
    let region = creds.region.trim();
    if region.is_empty() {
        DEFAULT_REGION.to_string()
    } else {
        region.to_string()
    }
}

fn ensure_region(region: &str) -> Result<(), OmniError> {
    if region.trim().is_empty() {
        Err(OmniError::invalid_input("请先配置 Region"))
    } else {
        Ok(())
    }
}

fn tc3_authorization(
    creds: &AliyunCredentials,
    service: &str,
    action: &str,
    host: &str,
    timestamp: i64,
    payload: &str,
) -> Result<String, OmniError> {
    let date = Utc
        .timestamp_opt(timestamp, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%d")
        .to_string();
    let hashed_payload = sha256_hex(payload.as_bytes());
    let canonical_headers = format!(
        "content-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{}\n",
        action.to_ascii_lowercase()
    );
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request = format!(
        "POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"
    );
    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_sha256(
        format!("TC3{}", creds.access_key_secret).as_bytes(),
        date.as_bytes(),
    )?;
    let secret_service = hmac_sha256(&secret_date, service.as_bytes())?;
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request")?;
    let signature = hex::encode(hmac_sha256(&secret_signing, string_to_sign.as_bytes())?);
    Ok(format!(
        "TC3-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id
    ))
}

pub async fn tc3_call(
    creds: &AliyunCredentials,
    http: &Client,
    service: &str,
    version: &str,
    action: &str,
    region: &str,
    body: Value,
) -> Result<Value, OmniError> {
    let host = format!("{service}.tencentcloudapi.com");
    let url = format!("https://{host}/");
    let payload = if body.is_null() {
        "{}".to_string()
    } else {
        serde_json::to_string(&body).unwrap_or_else(|_| "{}".into())
    };
    let timestamp = Utc::now().timestamp();
    let authorization = tc3_authorization(creds, service, action, &host, timestamp, &payload)?;
    let mut req = http
        .post(&url)
        .header("Authorization", authorization)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", &host)
        .header("X-TC-Action", action)
        .header("X-TC-Version", version)
        .header("X-TC-Timestamp", timestamp.to_string());
    if !region.trim().is_empty() {
        req = req.header("X-TC-Region", region.trim());
    }
    let resp = req.body(payload).send().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, format!("腾讯云 {action} 请求失败"))
            .with_cause(e.to_string())
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "读取腾讯云响应失败").with_cause(e.to_string())
    })?;
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if let Some((code, message)) = parse_error_json(&parsed) {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("腾讯云 {action} 失败: {code}"),
        )
        .with_cause(message));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("腾讯云 {action} 失败: HTTP {status}"),
        )
        .with_cause(text));
    }
    Ok(parsed
        .get("Response")
        .cloned()
        .unwrap_or(parsed))
}

async fn paginate(
    creds: &AliyunCredentials,
    http: &Client,
    service: &str,
    version: &str,
    action: &str,
    region: &str,
    extra: Value,
    list_keys: &[&str],
) -> Result<Vec<Value>, OmniError> {
    let mut out = Vec::new();
    let mut offset: u64 = 0;
    loop {
        let mut body = extra.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("Offset".into(), json!(offset));
            obj.insert("Limit".into(), json!(PAGE_LIMIT));
        } else {
            body = json!({ "Offset": offset, "Limit": PAGE_LIMIT });
        }
        let resp = tc3_call(creds, http, service, version, action, region, body).await?;
        let items = jarr(&resp, list_keys);
        let count = items.len() as u64;
        out.extend(items);
        if count == 0 || count < PAGE_LIMIT || out.len() as u64 >= PAGE_MAX {
            break;
        }
        offset += PAGE_LIMIT;
        if offset >= PAGE_MAX {
            break;
        }
    }
    if out.len() as u64 > PAGE_MAX {
        out.truncate(PAGE_MAX as usize);
    }
    Ok(out)
}

pub async fn list_cos_buckets(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Vec<Value>, OmniError> {
    let host = "service.cos.myqcloud.com";
    let now = Utc::now().timestamp();
    let key_time = format!("{now};{}", now + 600);
    let http_string = format!("get\n/\n\nhost={host}\n");
    let http_string_hash = hex::encode(Sha1::digest(http_string.as_bytes()));
    let string_to_sign = format!("sha1\n{key_time}\n{http_string_hash}");
    let sign_key = hex::encode(hmac_sha1_raw(
        creds.access_key_secret.as_bytes(),
        key_time.as_bytes(),
    )?);
    let signature = hex::encode(hmac_sha1_raw(sign_key.as_bytes(), string_to_sign.as_bytes())?);
    let authorization = format!(
        "q-sign-algorithm=sha1&q-ak={}&q-sign-time={key_time}&q-key-time={key_time}&q-header-list=host&q-url-param-list=&q-signature={signature}",
        creds.access_key_id
    );
    let resp = http
        .get(format!("https://{host}/"))
        .header("Host", host)
        .header("Authorization", authorization)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "COS GetService 请求失败")
                .with_cause(e.to_string())
        })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "读取 COS 响应失败").with_cause(e.to_string())
    })?;
    if !status.is_success() {
        let code = xml_tag(&text, "Code").unwrap_or("Unknown");
        let msg = xml_tag(&text, "Message").unwrap_or(text.trim());
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("COS GetService 失败: {code}"),
        )
        .with_cause(msg.to_string()));
    }
    let mut out = Vec::new();
    for block in collect_xml_blocks(&text, "Bucket") {
        out.push(json!({
            "Name": xml_tag(block, "Name").unwrap_or(""),
            "Location": xml_tag(block, "Location").unwrap_or(""),
            "CreationDate": xml_tag(block, "CreationDate").unwrap_or(""),
        }));
    }
    Ok(out)
}

pub async fn get_user_app_id(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Value, OmniError> {
    tc3_call(
        creds,
        http,
        "cam",
        "2019-01-16",
        "GetUserAppId",
        &region_or_default(creds),
        json!({}),
    )
    .await
}

pub async fn describe_account_balance(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Value, OmniError> {
    tc3_call(
        creds,
        http,
        "billing",
        "2018-07-09",
        "DescribeAccountBalance",
        &region_or_default(creds),
        json!({}),
    )
    .await
}

pub async fn describe_regions(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Vec<Value>, OmniError> {
    let body = tc3_call(
        creds,
        http,
        "cvm",
        "2017-03-12",
        "DescribeRegions",
        &region_or_default(creds),
        json!({}),
    )
    .await?;
    Ok(jarr(&body, &["RegionSet", "RegionList", "Region"]))
}

pub async fn describe_cvm_instances(
    creds: &AliyunCredentials,
    http: &Client,
    instance_ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if instance_ids.is_empty() {
        json!({})
    } else {
        json!({ "InstanceIds": instance_ids })
    };
    paginate(
        creds,
        http,
        "cvm",
        "2017-03-12",
        "DescribeInstances",
        &region,
        extra,
        &["InstanceSet", "Instance"],
    )
    .await
}

pub async fn cvm_instance_action(
    creds: &AliyunCredentials,
    http: &Client,
    action: &str,
    instance_id: &str,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let _ = tc3_call(
        creds,
        http,
        "cvm",
        "2017-03-12",
        action,
        &region,
        json!({ "InstanceIds": [instance_id] }),
    )
    .await?;
    Ok(())
}

pub async fn associate_cvm_security_groups(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
    group_id: &str,
    attach: bool,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let action = if attach {
        "AssociateSecurityGroups"
    } else {
        "DisassociateSecurityGroups"
    };
    let _ = tc3_call(
        creds,
        http,
        "cvm",
        "2017-03-12",
        action,
        &region,
        json!({
            "InstanceIds": [instance_id],
            "SecurityGroupIds": [group_id]
        }),
    )
    .await?;
    Ok(())
}

pub async fn describe_lighthouse_instances(
    creds: &AliyunCredentials,
    http: &Client,
    instance_ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if instance_ids.is_empty() {
        json!({})
    } else {
        json!({ "InstanceIds": instance_ids })
    };
    paginate(
        creds,
        http,
        "lighthouse",
        "2020-03-24",
        "DescribeInstances",
        &region,
        extra,
        &["InstanceSet", "Instance"],
    )
    .await
}

pub async fn lighthouse_instance_action(
    creds: &AliyunCredentials,
    http: &Client,
    action: &str,
    instance_id: &str,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let _ = tc3_call(
        creds,
        http,
        "lighthouse",
        "2020-03-24",
        action,
        &region,
        json!({ "InstanceIds": [instance_id] }),
    )
    .await?;
    Ok(())
}

pub async fn describe_lighthouse_firewall_rules(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    let body = tc3_call(
        creds,
        http,
        "lighthouse",
        "2020-03-24",
        "DescribeFirewallRules",
        &region,
        json!({ "InstanceId": instance_id, "Offset": 0, "Limit": 100 }),
    )
    .await?;
    Ok(jarr(&body, &["FirewallRuleSet", "FirewallRules"]))
}

pub async fn modify_lighthouse_firewall(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
    create: bool,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let protocol = nonempty_or(action.param("protocol").to_ascii_uppercase(), "TCP");
    let port = nonempty_or(action.param("portRange"), "ALL");
    let cidr = nonempty_or(action.param("cidr"), "0.0.0.0/0");
    let policy = nonempty_or(action.param("policy").to_ascii_uppercase(), "ACCEPT");
    let mut rule = json!({
        "Protocol": protocol,
        "Port": port,
        "CidrBlock": cidr,
        "Action": policy,
    });
    if let Some(desc) = nonempty_opt(action.param("description")) {
        rule["FirewallRuleDescription"] = json!(desc);
    }
    let api = if create {
        "CreateFirewallRules"
    } else {
        "DeleteFirewallRules"
    };
    let _ = tc3_call(
        creds,
        http,
        "lighthouse",
        "2020-03-24",
        api,
        &region,
        json!({
            "InstanceId": action.resource_id.trim(),
            "FirewallRules": [rule]
        }),
    )
    .await?;
    Ok(())
}

pub async fn describe_security_groups(
    creds: &AliyunCredentials,
    http: &Client,
    group_ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if group_ids.is_empty() {
        json!({})
    } else {
        json!({ "SecurityGroupIds": group_ids })
    };
    paginate(
        creds,
        http,
        "vpc",
        "2017-03-12",
        "DescribeSecurityGroups",
        &region,
        extra,
        &["SecurityGroupSet", "SecurityGroup"],
    )
    .await
}

pub async fn describe_security_group_policies(
    creds: &AliyunCredentials,
    http: &Client,
    group_id: &str,
) -> Result<Value, OmniError> {
    let region = region_or_default(creds);
    tc3_call(
        creds,
        http,
        "vpc",
        "2017-03-12",
        "DescribeSecurityGroupPolicies",
        &region,
        json!({ "SecurityGroupId": group_id }),
    )
    .await
}

pub async fn modify_security_group_policies(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
    create: bool,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let direction = action.param("direction").to_ascii_lowercase();
    let set_key = if direction == "egress" {
        "Egress"
    } else {
        "Ingress"
    };
    let mut policy = json!({});
    if let Some(idx) = nonempty_opt(action.param("ruleId")) {
        if let Ok(n) = idx.parse::<i64>() {
            policy["PolicyIndex"] = json!(n);
        }
    }
    let protocol = action.param("protocol");
    if !protocol.is_empty() {
        policy["Protocol"] = json!(protocol.to_ascii_uppercase());
    }
    let port = action.param("portRange");
    if !port.is_empty() {
        policy["Port"] = json!(port);
    }
    let cidr = action.param("cidr");
    if !cidr.is_empty() {
        policy["CidrBlock"] = json!(cidr);
    }
    let policy_action = nonempty_or(action.param("policy").to_ascii_uppercase(), "ACCEPT");
    policy["Action"] = json!(policy_action);
    if let Some(desc) = nonempty_opt(action.param("description")) {
        policy["PolicyDescription"] = json!(desc);
    }
    if let Some(src) = nonempty_opt(action.param("sourceGroupId")) {
        policy["SecurityGroupId"] = json!(src);
    }
    let api = if create {
        "CreateSecurityGroupPolicies"
    } else {
        "DeleteSecurityGroupPolicies"
    };
    let _ = tc3_call(
        creds,
        http,
        "vpc",
        "2017-03-12",
        api,
        &region,
        json!({
            "SecurityGroupId": action.resource_id.trim(),
            "SecurityGroupPolicySet": { set_key: [policy] }
        }),
    )
    .await?;
    Ok(())
}

pub async fn describe_addresses(
    creds: &AliyunCredentials,
    http: &Client,
    address_ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if address_ids.is_empty() {
        json!({})
    } else {
        json!({ "AddressIds": address_ids })
    };
    paginate(
        creds,
        http,
        "vpc",
        "2017-03-12",
        "DescribeAddresses",
        &region,
        extra,
        &["AddressSet", "Address"],
    )
    .await
}

pub async fn associate_address(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
    attach: bool,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let address_id = action.resource_id.trim();
    if attach {
        let instance_id = action.param("instanceId");
        if instance_id.is_empty() {
            return Err(OmniError::invalid_input("缺少要绑定的实例 id"));
        }
        let _ = tc3_call(
            creds,
            http,
            "vpc",
            "2017-03-12",
            "AssociateAddress",
            &region,
            json!({ "AddressId": address_id, "InstanceId": instance_id }),
        )
        .await?;
    } else {
        let _ = tc3_call(
            creds,
            http,
            "vpc",
            "2017-03-12",
            "DisassociateAddress",
            &region,
            json!({ "AddressId": address_id }),
        )
        .await?;
    }
    Ok(())
}

pub async fn modify_address_bandwidth(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
) -> Result<(), OmniError> {
    let bandwidth = action.param("bandwidth");
    if bandwidth.is_empty() {
        return Err(OmniError::invalid_input("请填写带宽"));
    }
    let region = region_or_default(creds);
    let bandwidth_num: i64 = bandwidth.parse().unwrap_or(1);
    let by_charge = tc3_call(
        creds,
        http,
        "vpc",
        "2017-03-12",
        "ModifyAddressInternetChargeType",
        &region,
        json!({
            "AddressId": action.resource_id.trim(),
            "InternetMaxBandwidthOut": bandwidth_num
        }),
    )
    .await;
    if by_charge.is_ok() {
        return Ok(());
    }
    let _ = tc3_call(
        creds,
        http,
        "vpc",
        "2017-03-12",
        "ModifyAddressesBandwidth",
        &region,
        json!({
            "AddressIds": [action.resource_id.trim()],
            "InternetMaxBandwidthOut": bandwidth_num
        }),
    )
    .await?;
    Ok(())
}

pub async fn describe_load_balancers(
    creds: &AliyunCredentials,
    http: &Client,
    ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if ids.is_empty() {
        json!({})
    } else {
        json!({ "LoadBalancerIds": ids })
    };
    paginate(
        creds,
        http,
        "clb",
        "2018-03-17",
        "DescribeLoadBalancers",
        &region,
        extra,
        &["LoadBalancerSet", "LoadBalancer"],
    )
    .await
}

pub async fn describe_clb_listeners(
    creds: &AliyunCredentials,
    http: &Client,
    lb_id: &str,
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    let body = tc3_call(
        creds,
        http,
        "clb",
        "2018-03-17",
        "DescribeListeners",
        &region,
        json!({ "LoadBalancerId": lb_id }),
    )
    .await?;
    Ok(jarr(&body, &["Listeners", "ListenerSet"]))
}

pub async fn describe_clb_targets(
    creds: &AliyunCredentials,
    http: &Client,
    lb_id: &str,
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    let body = tc3_call(
        creds,
        http,
        "clb",
        "2018-03-17",
        "DescribeTargets",
        &region,
        json!({ "LoadBalancerId": lb_id }),
    )
    .await?;
    Ok(jarr(&body, &["Listeners", "ListenerSet"]))
}

pub async fn describe_cdb_instances(
    creds: &AliyunCredentials,
    http: &Client,
    ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if ids.is_empty() {
        json!({})
    } else {
        json!({ "InstanceIds": ids })
    };
    paginate(
        creds,
        http,
        "cdb",
        "2017-03-20",
        "DescribeDBInstances",
        &region,
        extra,
        &["Items", "InstanceSet"],
    )
    .await
}

pub async fn cdb_instance_action(
    creds: &AliyunCredentials,
    http: &Client,
    action: &str,
    instance_id: &str,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let _ = tc3_call(
        creds,
        http,
        "cdb",
        "2017-03-20",
        action,
        &region,
        json!({ "InstanceIds": [instance_id] }),
    )
    .await?;
    Ok(())
}

pub async fn describe_cdb_security_groups(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    let body = tc3_call(
        creds,
        http,
        "cdb",
        "2017-03-20",
        "DescribeDBSecurityGroups",
        &region,
        json!({ "InstanceId": instance_id }),
    )
    .await?;
    Ok(jarr(&body, &["Groups", "SecurityGroup"]))
}

pub async fn modify_cdb_security_groups(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
    group_ids: &[String],
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let _ = tc3_call(
        creds,
        http,
        "cdb",
        "2017-03-20",
        "ModifyDBInstanceSecurityGroups",
        &region,
        json!({
            "InstanceId": instance_id,
            "SecurityGroupIds": group_ids
        }),
    )
    .await?;
    Ok(())
}

pub async fn describe_cdb_slow_logs(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
    query: &CloudLogQuery,
) -> Result<Value, OmniError> {
    let region = region_or_default(creds);
    let (start, end) = log_window_sec(query);
    let page = if query.page > 0 { query.page } else { 1 };
    let page_size = if query.page_size > 0 {
        query.page_size.min(100)
    } else {
        50
    };
    let mut extra = json!({
        "InstanceId": instance_id,
        "StartTime": format_tc_time_sec(start),
        "EndTime": format_tc_time_sec(end),
        "Offset": (page - 1) * page_size,
        "Limit": page_size,
    });
    if let Some(db) = query.trimmed_db_name() {
        extra["Database"] = json!(db);
    }
    tc3_call(
        creds,
        http,
        "cdb",
        "2017-03-20",
        "DescribeSlowLogs",
        &region,
        extra,
    )
    .await
}

pub async fn describe_redis_instances(
    creds: &AliyunCredentials,
    http: &Client,
    ids: &[String],
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let extra = if ids.is_empty() {
        json!({})
    } else {
        json!({ "InstanceIds": ids })
    };
    paginate(
        creds,
        http,
        "redis",
        "2018-04-12",
        "DescribeInstances",
        &region,
        extra,
        &["InstanceSet", "Instance"],
    )
    .await
}

pub async fn redis_restart(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let _ = tc3_call(
        creds,
        http,
        "redis",
        "2018-04-12",
        "RestartInstance",
        &region,
        json!({ "InstanceId": instance_id }),
    )
    .await?;
    Ok(())
}

pub async fn describe_redis_slow_log(
    creds: &AliyunCredentials,
    http: &Client,
    instance_id: &str,
    query: &CloudLogQuery,
) -> Result<Value, OmniError> {
    let region = region_or_default(creds);
    let (start, end) = log_window_sec(query);
    let page = if query.page > 0 { query.page } else { 1 };
    let page_size = if query.page_size > 0 {
        query.page_size.min(100)
    } else {
        50
    };
    tc3_call(
        creds,
        http,
        "redis",
        "2018-04-12",
        "DescribeSlowLog",
        &region,
        json!({
            "InstanceId": instance_id,
            "BeginTime": format_tc_time_sec(start),
            "EndTime": format_tc_time_sec(end),
            "MinQueryTime": 0,
            "Limit": page_size,
            "Offset": (page - 1) * page_size
        }),
    )
    .await
}

pub async fn describe_disks(
    creds: &AliyunCredentials,
    http: &Client,
    disk_ids: &[String],
    instance_id: Option<&str>,
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    ensure_region(&region)?;
    let mut extra = json!({});
    if !disk_ids.is_empty() {
        extra["DiskIds"] = json!(disk_ids);
    }
    if let Some(id) = instance_id.filter(|s| !s.is_empty()) {
        extra["Filters"] = json!([{ "Name": "instance-id", "Values": [id] }]);
    }
    paginate(
        creds,
        http,
        "cbs",
        "2017-03-12",
        "DescribeDisks",
        &region,
        extra,
        &["DiskSet", "Disk"],
    )
    .await
}

pub async fn describe_snapshots(
    creds: &AliyunCredentials,
    http: &Client,
    disk_id: Option<&str>,
    instance_id: Option<&str>,
) -> Result<Vec<Value>, OmniError> {
    let region = region_or_default(creds);
    let mut extra = json!({});
    if let Some(id) = disk_id.filter(|s| !s.is_empty()) {
        extra["Filters"] = json!([{ "Name": "disk-id", "Values": [id] }]);
    } else if let Some(id) = instance_id.filter(|s| !s.is_empty()) {
        extra["Filters"] = json!([{ "Name": "instance-id", "Values": [id] }]);
    }
    paginate(
        creds,
        http,
        "cbs",
        "2017-03-12",
        "DescribeSnapshots",
        &region,
        extra,
        &["SnapshotSet", "Snapshot"],
    )
    .await
}

pub async fn attach_disks(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
    attach: bool,
) -> Result<(), OmniError> {
    let region = region_or_default(creds);
    let disk_id = action.resource_id.trim();
    let instance_id = action.param("instanceId");
    if attach && instance_id.is_empty() {
        return Err(OmniError::invalid_input("缺少要挂载的实例 id"));
    }
    let api = if attach { "AttachDisks" } else { "DetachDisks" };
    let mut body = json!({ "DiskIds": [disk_id] });
    if !instance_id.is_empty() {
        body["InstanceId"] = json!(instance_id);
    }
    let _ = tc3_call(creds, http, "cbs", "2017-03-12", api, &region, body).await?;
    Ok(())
}

pub async fn create_snapshot(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
) -> Result<(), OmniError> {
    let disk_id = action.param("diskId");
    let disk_id = if disk_id.is_empty() {
        action.resource_id.trim().to_string()
    } else {
        disk_id
    };
    if disk_id.is_empty() {
        return Err(OmniError::invalid_input("缺少云盘 id"));
    }
    let region = region_or_default(creds);
    let mut body = json!({ "DiskId": disk_id });
    if let Some(name) = nonempty_opt(action.param("snapshotName")) {
        body["SnapshotName"] = json!(name);
    }
    let _ = tc3_call(
        creds,
        http,
        "cbs",
        "2017-03-12",
        "CreateSnapshot",
        &region,
        body,
    )
    .await?;
    Ok(())
}

pub async fn describe_dnspod_domains(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Vec<Value>, OmniError> {
    paginate(
        creds,
        http,
        "dnspod",
        "2021-03-23",
        "DescribeDomainList",
        DEFAULT_REGION,
        json!({}),
        &["DomainList", "DomainSet"],
    )
    .await
}

pub async fn describe_dnspod_records(
    creds: &AliyunCredentials,
    http: &Client,
    domain: &str,
) -> Result<Vec<Value>, OmniError> {
    paginate(
        creds,
        http,
        "dnspod",
        "2021-03-23",
        "DescribeRecordList",
        DEFAULT_REGION,
        json!({ "Domain": domain }),
        &["RecordList", "RecordSet"],
    )
    .await
}

pub async fn mutate_dnspod_record(
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
    kind: &str,
) -> Result<(), OmniError> {
    let domain = action.resource_id.trim();
    if domain.is_empty() {
        return Err(OmniError::invalid_input("缺少域名"));
    }
    let api = match kind {
        "add" => {
            let rr = action.param("rr");
            let rtype = action.param("type");
            let value = action.param("value");
            if rr.is_empty() || rtype.is_empty() || value.is_empty() {
                return Err(OmniError::invalid_input("解析记录需要主机记录、类型与记录值"));
            }
            let mut body = json!({
                "Domain": domain,
                "SubDomain": rr,
                "RecordType": rtype.to_ascii_uppercase(),
                "RecordLine": nonempty_or(action.param("line"), "默认"),
                "Value": value,
            });
            if let Some(ttl) = nonempty_opt(action.param("ttl")) {
                if let Ok(n) = ttl.parse::<u64>() {
                    body["TTL"] = json!(n);
                }
            }
            ("CreateRecord", body)
        }
        "update" => {
            let record_id = action.param("recordId");
            if record_id.is_empty() {
                return Err(OmniError::invalid_input("缺少记录 id"));
            }
            let mut body = json!({
                "Domain": domain,
                "RecordId": record_id.parse::<u64>().unwrap_or(0),
                "SubDomain": nonempty_or(action.param("rr"), "@"),
                "RecordType": nonempty_or(action.param("type").to_ascii_uppercase(), "A"),
                "RecordLine": nonempty_or(action.param("line"), "默认"),
                "Value": action.param("value"),
            });
            if let Some(ttl) = nonempty_opt(action.param("ttl")) {
                if let Ok(n) = ttl.parse::<u64>() {
                    body["TTL"] = json!(n);
                }
            }
            ("ModifyRecord", body)
        }
        _ => {
            let record_id = action.param("recordId");
            if record_id.is_empty() {
                return Err(OmniError::invalid_input("缺少记录 id"));
            }
            (
                "DeleteRecord",
                json!({
                    "Domain": domain,
                    "RecordId": record_id.parse::<u64>().unwrap_or(0)
                }),
            )
        }
    };
    let _ = tc3_call(creds, http, "dnspod", "2021-03-23", api.0, DEFAULT_REGION, api.1).await?;
    Ok(())
}

pub async fn describe_registered_domains(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Vec<Value>, OmniError> {
    paginate(
        creds,
        http,
        "domain",
        "2018-08-08",
        "DescribeDomainList",
        DEFAULT_REGION,
        json!({}),
        &["DomainSet", "DomainList"],
    )
    .await
}

pub async fn describe_certificates(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Vec<Value>, OmniError> {
    paginate(
        creds,
        http,
        "ssl",
        "2019-12-05",
        "DescribeCertificates",
        DEFAULT_REGION,
        json!({}),
        &["Certificates", "CertificateSet"],
    )
    .await
}

pub async fn get_monitor_data(
    creds: &AliyunCredentials,
    http: &Client,
    namespace: &str,
    metric_name: &str,
    instance_id: &str,
    dimension_name: &str,
    start_ms: i64,
    end_ms: i64,
    period: i64,
) -> Result<Value, OmniError> {
    let region = region_or_default(creds);
    tc3_call(
        creds,
        http,
        "monitor",
        "2018-07-24",
        "GetMonitorData",
        &region,
        json!({
            "Namespace": namespace,
            "MetricName": metric_name,
            "Period": period,
            "StartTime": format_monitor_time(start_ms),
            "EndTime": format_monitor_time(end_ms),
            "Instances": [{
                "Dimensions": [{
                    "Name": dimension_name,
                    "Value": instance_id
                }]
            }]
        }),
    )
    .await
}

fn format_monitor_time(ms: i64) -> String {
    let ms = if ms > 0 && ms < 1_000_000_000_000 {
        ms.saturating_mul(1000)
    } else {
        ms
    };
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S+08:00").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00+08:00".into())
}

fn format_tc_time_sec(sec: i64) -> String {
    Utc.timestamp_opt(sec, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "1970-01-01 00:00:00".into())
}

fn log_window_sec(query: &CloudLogQuery) -> (i64, i64) {
    let now = Utc::now().timestamp();
    let mut end = normalize_epoch_sec(query.end_ms);
    if end <= 0 {
        end = now;
    }
    if end > now {
        end = now;
    }
    let mut start = normalize_epoch_sec(query.start_ms);
    if start <= 0 {
        start = end.saturating_sub(24 * 3600);
    }
    if start >= end {
        start = end.saturating_sub(3600);
    }
    (start, end)
}

fn normalize_epoch_sec(ts: i64) -> i64 {
    if ts > 1_000_000_000_000 {
        ts / 1000
    } else {
        ts
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
    fn empty_body_sha256_is_fixed() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hmac_sha256_is_nonempty() {
        let out = hmac_sha256(b"key", b"data").expect("hmac");
        assert!(!out.is_empty());
    }

    #[test]
    fn error_json_reads_code_and_message() {
        let body = json!({
            "Response": {
                "Error": {
                    "Code": "AuthFailure.SecretIdNotFound",
                    "Message": "The SecretId is not found, please check your SecretId."
                },
                "RequestId": "req-1"
            }
        });
        let (code, message) = parse_error_json(&body).expect("error");
        assert_eq!(code, "AuthFailure.SecretIdNotFound");
        assert!(message.contains("SecretId"));
    }

    #[test]
    fn jips_reads_public_array() {
        let item = json!({
            "PublicIpAddresses": ["1.2.3.4", "5.6.7.8"],
            "PrivateIpAddresses": ["10.0.0.2"]
        });
        assert_eq!(jips(&item, &["PublicIpAddresses"]), "1.2.3.4,5.6.7.8");
        assert_eq!(jips(&item, &["PrivateIpAddresses"]), "10.0.0.2");
    }
}
