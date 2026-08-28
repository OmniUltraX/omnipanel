//! 阿里云 OpenAPI（RPC HMAC-SHA1）与 OSS ListBuckets 只读客户端。

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use sha1::Sha1;
use tokio::sync::Semaphore;

use omnipanel_error::{ErrorCode, OmniError};

type HmacSha1 = Hmac<Sha1>;

/// 阿里云 RPC / OSS 请求凭据。
#[derive(Debug, Clone)]
pub struct AliyunCredentials {
    pub access_key_id: String,
    pub access_key_secret: String,
    /// 默认地域，如 `cn-hangzhou`。
    pub region: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudOssBucket {
    pub name: String,
    pub location: String,
    pub creation_date: String,
    pub storage_class: String,
    pub extranet_endpoint: String,
    pub intranet_endpoint: String,
    pub region: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudSwasInstance {
    pub instance_id: String,
    pub instance_name: String,
    pub status: String,
    pub region_id: String,
    pub public_ip_address: String,
    pub private_ip_address: String,
    pub image_id: String,
    pub instance_plan: String,
    pub creation_time: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudDomainItem {
    pub domain_name: String,
    pub instance_id: String,
    pub registration_date: String,
    pub expiration_date: String,
    pub domain_status: String,
    pub domain_type: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudEcsInstance {
    pub instance_id: String,
    pub instance_name: String,
    pub status: String,
    pub region_id: String,
    pub zone_id: String,
    pub instance_type: String,
    pub public_ip_address: String,
    pub private_ip_address: String,
    pub os_name: String,
    pub creation_time: String,
}

#[derive(Debug, Clone, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRegion {
    pub region_id: String,
    pub local_name: String,
    pub has_ecs: bool,
    pub has_swas: bool,
}

/// DescribeRegions 失败时用于探测的常用地域（含用户未手选的地域）。
const FALLBACK_REGION_IDS: &[&str] = &[
    "cn-hangzhou",
    "cn-shanghai",
    "cn-qingdao",
    "cn-beijing",
    "cn-zhangjiakou",
    "cn-huhehaote",
    "cn-wulanchabu",
    "cn-shenzhen",
    "cn-heyuan",
    "cn-guangzhou",
    "cn-chengdu",
    "cn-hongkong",
    "cn-wuhan",
    "cn-nanjing",
    "cn-fuzhou",
    "ap-southeast-1",
    "ap-southeast-3",
    "ap-southeast-5",
    "ap-northeast-1",
    "us-west-1",
    "us-east-1",
    "eu-central-1",
    "eu-west-1",
    "me-central-1",
];

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudCertificateItem {
    pub order_id: String,
    pub name: String,
    pub domain: String,
    pub status: String,
    pub product_name: String,
    pub cert_type: String,
    pub buy_date: String,
    pub end_date: String,
}

fn aliyun_percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

fn hmac_sha1_base64(key: &str, data: &str) -> Result<String, OmniError> {
    let mut mac = HmacSha1::new_from_slice(key.as_bytes()).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "HMAC 初始化失败").with_cause(e.to_string())
    })?;
    mac.update(data.as_bytes());
    Ok(B64.encode(mac.finalize().into_bytes()))
}

fn signature_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{nanos:x}")
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

fn json_arr(v: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        if let Some(arr) = v.get(*key).and_then(|x| x.as_array()) {
            return arr.clone();
        }
        if let Some(obj) = v.get(*key).and_then(|x| x.as_object()) {
            for nested in ["Instance", "Domain", "CertificateOrder", "Region"] {
                if let Some(arr) = obj.get(nested).and_then(|x| x.as_array()) {
                    return arr.clone();
                }
                if let Some(one) = obj.get(nested) {
                    if one.is_null() {
                        continue;
                    }
                    if one.as_object().is_some_and(|o| o.is_empty()) {
                        continue;
                    }
                    return vec![one.clone()];
                }
            }
        }
    }
    Vec::new()
}

fn json_total_count(v: &Value) -> u64 {
    for key in ["TotalCount", "totalCount"] {
        if let Some(n) = v.get(key).and_then(|x| x.as_u64()) {
            return n;
        }
        if let Some(n) = v.get(key).and_then(|x| x.as_i64()).filter(|n| *n >= 0) {
            return n as u64;
        }
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if let Ok(n) = s.parse::<u64>() {
                return n;
            }
        }
    }
    json_arr(v, &["Instances", "Instance"]).len() as u64
}

fn str_field(v: &Value, keys: &[&str]) -> String {
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
        if let Some(arr) = v.get(*key).and_then(|x| x.as_array()) {
            let joined: Vec<String> = arr
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect();
            if !joined.is_empty() {
                return joined.join(",");
            }
            // IpAddress 常见嵌套：{ IpAddress: ["1.2.3.4"] }
            let nested: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    item.get("IpAddress")
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                })
                .collect();
            if !nested.is_empty() {
                return nested.join(",");
            }
        }
        if let Some(obj) = v.get(*key).and_then(|x| x.as_object()) {
            if let Some(arr) = obj.get("IpAddress").and_then(|x| x.as_array()) {
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect();
                if !joined.is_empty() {
                    return joined.join(",");
                }
            }
            if let Some(s) = obj.get("IpAddress").and_then(|x| x.as_str()) {
                return s.to_string();
            }
            if let Some(nested) = obj.get("PrivateIpAddress") {
                let inner = str_field(nested, &["IpAddress"]);
                if !inner.is_empty() {
                    return inner;
                }
                if let Some(s) = nested.as_str() {
                    return s.to_string();
                }
            }
        }
    }
    String::new()
}

fn instance_private_ip(item: &Value) -> String {
    let direct = str_field(item, &["InnerIpAddress", "PrivateIpAddress"]);
    if !direct.is_empty() {
        return direct;
    }
    if let Some(vpc) = item.get("VpcAttributes") {
        let ip = str_field(vpc, &["PrivateIpAddress", "InnerIpAddress"]);
        if !ip.is_empty() {
            return ip;
        }
    }
    String::new()
}

fn parse_ecs_instance(item: &Value) -> CloudEcsInstance {
    let public_ip = str_field(
        item,
        &["PublicIpAddress", "EipAddress", "PublicIpAddresses"],
    );
    let eip = item
        .get("EipAddress")
        .and_then(|e| e.get("IpAddress"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    CloudEcsInstance {
        instance_id: str_field(item, &["InstanceId"]),
        instance_name: str_field(item, &["InstanceName"]),
        status: str_field(item, &["Status"]),
        region_id: str_field(item, &["RegionId"]),
        zone_id: str_field(item, &["ZoneId"]),
        instance_type: str_field(item, &["InstanceType"]),
        public_ip_address: if public_ip.is_empty() { eip } else { public_ip },
        private_ip_address: instance_private_ip(item),
        os_name: str_field(item, &["OSName", "OSNameEn"]),
        creation_time: str_field(item, &["CreationTime"]),
    }
}

fn parse_swas_instance(item: &Value) -> CloudSwasInstance {
    CloudSwasInstance {
        instance_id: str_field(item, &["InstanceId"]),
        instance_name: str_field(item, &["InstanceName"]),
        status: str_field(item, &["Status"]),
        region_id: str_field(item, &["RegionId"]),
        public_ip_address: str_field(item, &["PublicIpAddress", "PublicIpAddresses"]),
        private_ip_address: str_field(item, &["PrivateIpAddress", "InnerIpAddress"]),
        image_id: str_field(item, &["ImageId"]),
        instance_plan: str_field(item, &["PlanId", "InstancePlan"]),
        creation_time: str_field(item, &["CreationTime", "CreatedTime"]),
    }
}

fn fallback_regions() -> Vec<CloudRegion> {
    FALLBACK_REGION_IDS
        .iter()
        .map(|id| CloudRegion {
            region_id: (*id).to_string(),
            local_name: String::new(),
            has_ecs: false,
            has_swas: false,
        })
        .collect()
}

pub(crate) fn select_visible_cloud_regions(
    mut described: Vec<CloudRegion>,
    occupied_ecs: &HashSet<String>,
    occupied_swas: &HashSet<String>,
    configured: &[String],
    probes_ok: usize,
) -> Vec<CloudRegion> {
    let configured_set: HashSet<String> = configured
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    for region in &mut described {
        region.has_ecs = occupied_ecs.contains(&region.region_id);
        region.has_swas = occupied_swas.contains(&region.region_id);
    }

    let described_ids: HashSet<String> = described.iter().map(|r| r.region_id.clone()).collect();
    let found_any = !occupied_ecs.is_empty() || !occupied_swas.is_empty();
    let show_all = probes_ok == 0 || !found_any;
    let mut out: Vec<CloudRegion> = if show_all {
        described
    } else {
        described
            .into_iter()
            .filter(|r| r.has_ecs || r.has_swas || configured_set.contains(&r.region_id))
            .collect()
    };

    for id in configured {
        let id = id.trim();
        if id.is_empty() || described_ids.contains(id) {
            continue;
        }
        if out.iter().any(|r| r.region_id == id) {
            continue;
        }
        out.push(CloudRegion {
            region_id: id.to_string(),
            local_name: String::new(),
            has_ecs: occupied_ecs.contains(id),
            has_swas: occupied_swas.contains(id),
        });
    }

    if out.is_empty() {
        for id in configured {
            let id = id.trim();
            if id.is_empty() {
                continue;
            }
            out.push(CloudRegion {
                region_id: id.to_string(),
                local_name: String::new(),
                has_ecs: false,
                has_swas: false,
            });
        }
    }
    out
}

impl AliyunCredentials {
    pub async fn test_credentials(&self, http: &Client) -> Result<String, OmniError> {
        // STS GetCallerIdentity：不依赖特定产品权限，适合连通性校验。
        let body = self
            .rpc_call(
                http,
                "https://sts.aliyuncs.com/",
                "2015-04-01",
                "GetCallerIdentity",
                BTreeMap::new(),
            )
            .await?;
        let account = str_field(&body, &["AccountId"]);
        let arn = str_field(&body, &["Arn"]);
        if account.is_empty() && arn.is_empty() {
            return Ok("凭证有效".into());
        }
        if arn.is_empty() {
            return Ok(format!("AccountId={account}"));
        }
        Ok(format!("AccountId={account}; Arn={arn}"))
    }

    pub async fn list_oss_buckets(&self, http: &Client) -> Result<Vec<CloudOssBucket>, OmniError> {
        let region = self.region.trim();
        let host = if region.is_empty() {
            "oss.aliyuncs.com".to_string()
        } else {
            let oss_region = if region.starts_with("oss-") {
                region.to_string()
            } else {
                format!("oss-{region}")
            };
            format!("{oss_region}.aliyuncs.com")
        };
        let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        let string_to_sign = format!("GET\n\n\n{date}\n/");
        let signature = hmac_sha1_base64(&self.access_key_secret, &string_to_sign)?;
        let url = format!("https://{host}/");
        let resp = http
            .get(&url)
            .header("Date", &date)
            .header(
                "Authorization",
                format!("OSS {}:{}", self.access_key_id, signature),
            )
            .send()
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Connection, "OSS ListBuckets 请求失败")
                    .with_cause(e.to_string())
            })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "读取 OSS 响应失败").with_cause(e.to_string())
        })?;
        if !status.is_success() {
            let code = xml_tag(&text, "Code").unwrap_or("Unknown");
            let msg = xml_tag(&text, "Message").unwrap_or(text.trim());
            return Err(OmniError::new(
                ErrorCode::Connection,
                format!("OSS ListBuckets 失败: {code}"),
            )
            .with_cause(msg.to_string()));
        }

        let mut out = Vec::new();
        for block in collect_xml_blocks(&text, "Bucket") {
            out.push(CloudOssBucket {
                name: xml_tag(block, "Name").unwrap_or("").to_string(),
                location: xml_tag(block, "Location").unwrap_or("").to_string(),
                creation_date: xml_tag(block, "CreationDate").unwrap_or("").to_string(),
                storage_class: xml_tag(block, "StorageClass").unwrap_or("").to_string(),
                extranet_endpoint: xml_tag(block, "ExtranetEndpoint").unwrap_or("").to_string(),
                intranet_endpoint: xml_tag(block, "IntranetEndpoint").unwrap_or("").to_string(),
                region: xml_tag(block, "Region").unwrap_or("").to_string(),
            });
        }
        Ok(out)
    }

    pub async fn list_swas_instances(
        &self,
        http: &Client,
    ) -> Result<Vec<CloudSwasInstance>, OmniError> {
        let region = self.region.trim();
        if region.is_empty() {
            return Err(OmniError::invalid_input("请先配置默认 Region"));
        }
        let endpoint = format!("https://swas.{region}.aliyuncs.com/");
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "100".into());
            let body = self
                .rpc_call(http, &endpoint, "2020-06-01", "ListInstances", params)
                .await?;
            let instances = json_arr(&body, &["Instances", "Instance"]);
            let count = instances.len();
            out.extend(instances.iter().map(parse_swas_instance));
            let total = json_total_count(&body);
            if count == 0 || out.len() as u64 >= total || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn list_domains(&self, http: &Client) -> Result<Vec<CloudDomainItem>, OmniError> {
        let mut params = BTreeMap::new();
        params.insert("PageNum".into(), "1".into());
        params.insert("PageSize".into(), "50".into());
        let body = self
            .rpc_call(
                http,
                "https://domain.aliyuncs.com/",
                "2018-01-29",
                "QueryDomainList",
                params,
            )
            .await?;
        let domains = json_arr(&body, &["Data", "Domain"]);
        Ok(domains
            .iter()
            .map(|item| CloudDomainItem {
                domain_name: str_field(item, &["DomainName"]),
                instance_id: str_field(item, &["InstanceId"]),
                registration_date: str_field(item, &["RegistrationDate", "RegistrationDateLong"]),
                expiration_date: str_field(item, &["ExpirationDate", "ExpirationDateLong"]),
                domain_status: str_field(item, &["DomainStatus", "Status"]),
                domain_type: str_field(item, &["DomainType", "ProductId"]),
            })
            .collect())
    }

    pub async fn list_ecs_instances(
        &self,
        http: &Client,
    ) -> Result<Vec<CloudEcsInstance>, OmniError> {
        let region = self.region.trim();
        if region.is_empty() {
            return Err(OmniError::invalid_input("请先配置默认 Region"));
        }
        let endpoint = format!("https://ecs.{region}.aliyuncs.com/");
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "100".into());
            let body = self
                .rpc_call(http, &endpoint, "2014-05-26", "DescribeInstances", params)
                .await?;
            let instances = json_arr(&body, &["Instances", "Instance"]);
            let count = instances.len();
            out.extend(instances.iter().map(parse_ecs_instance));
            let total = json_total_count(&body);
            if count == 0 || out.len() as u64 >= total || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn list_regions(&self, http: &Client) -> Result<Vec<CloudRegion>, OmniError> {
        let mut params = BTreeMap::new();
        params.insert("AcceptLanguage".into(), "zh-CN".into());
        let body = self
            .rpc_call(
                http,
                "https://ecs.aliyuncs.com/",
                "2014-05-26",
                "DescribeRegions",
                params,
            )
            .await?;
        Ok(json_arr(&body, &["Regions", "Region"])
            .iter()
            .filter_map(|item| {
                let region_id = str_field(item, &["RegionId"]);
                if region_id.is_empty() {
                    return None;
                }
                Some(CloudRegion {
                    region_id,
                    local_name: str_field(item, &["LocalName"]),
                    has_ecs: false,
                    has_swas: false,
                })
            })
            .collect())
    }

    async fn ecs_total_count(&self, http: &Client, region: &str) -> Result<u64, OmniError> {
        let endpoint = format!("https://ecs.{region}.aliyuncs.com/");
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("PageNumber".into(), "1".into());
        params.insert("PageSize".into(), "1".into());
        let body = self
            .rpc_call(http, &endpoint, "2014-05-26", "DescribeInstances", params)
            .await?;
        Ok(json_total_count(&body))
    }

    async fn swas_total_count(&self, http: &Client, region: &str) -> Result<u64, OmniError> {
        let endpoint = format!("https://swas.{region}.aliyuncs.com/");
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("PageNumber".into(), "1".into());
        params.insert("PageSize".into(), "1".into());
        let body = self
            .rpc_call(http, &endpoint, "2020-06-01", "ListInstances", params)
            .await?;
        Ok(json_total_count(&body))
    }

    pub async fn discover_regions(
        &self,
        http: &Client,
        configured: &[String],
    ) -> Result<Vec<CloudRegion>, OmniError> {
        let described = match self.list_regions(http).await {
            Ok(list) if !list.is_empty() => list,
            _ => fallback_regions(),
        };
        let sem = Arc::new(Semaphore::new(8));
        let probes = described.iter().map(|region| {
            let id = region.region_id.clone();
            let sem = sem.clone();
            let creds = self.clone();
            let http = http.clone();
            async move {
                let _permit = sem.acquire().await.ok();
                let ecs = creds.ecs_total_count(&http, &id).await.ok();
                let swas = creds.swas_total_count(&http, &id).await.ok();
                (id, ecs, swas)
            }
        });
        let results = futures::future::join_all(probes).await;
        let mut occupied_ecs = HashSet::new();
        let mut occupied_swas = HashSet::new();
        let mut probes_ok = 0usize;
        for (id, ecs, swas) in results {
            if let Some(count) = ecs {
                probes_ok += 1;
                if count > 0 {
                    occupied_ecs.insert(id.clone());
                }
            }
            if let Some(count) = swas {
                probes_ok += 1;
                if count > 0 {
                    occupied_swas.insert(id);
                }
            }
        }
        Ok(select_visible_cloud_regions(
            described,
            &occupied_ecs,
            &occupied_swas,
            configured,
            probes_ok,
        ))
    }

    pub async fn list_certificates(
        &self,
        http: &Client,
    ) -> Result<Vec<CloudCertificateItem>, OmniError> {
        let mut params = BTreeMap::new();
        params.insert("CurrentPage".into(), "1".into());
        params.insert("ShowSize".into(), "50".into());
        // 1=上传证书订单；也可不传 Status 拉全部（视产品权限而定）
        params.insert("OrderType".into(), "CERT".into());
        let body = self
            .rpc_call(
                http,
                "https://cas.aliyuncs.com/",
                "2020-04-07",
                "ListUserCertificateOrder",
                params,
            )
            .await?;
        let orders = json_arr(&body, &["CertificateOrderList", "CertificateOrder"]);
        Ok(orders
            .iter()
            .map(|item| CloudCertificateItem {
                order_id: str_field(item, &["OrderId", "CertificateId", "InstanceId"]),
                name: str_field(item, &["Name", "CertName"]),
                domain: str_field(item, &["Domain", "Sans"]),
                status: str_field(item, &["Status", "CertStatus"]),
                product_name: str_field(item, &["ProductName", "ProductCode"]),
                cert_type: str_field(item, &["CertType", "CertificateType"]),
                buy_date: str_field(item, &["BuyDate", "StartDate"]),
                end_date: str_field(item, &["EndDate", "ExpiredTime"]),
            })
            .collect())
    }

    async fn rpc_call(
        &self,
        http: &Client,
        endpoint: &str,
        version: &str,
        action: &str,
        extra: BTreeMap<String, String>,
    ) -> Result<Value, OmniError> {
        let mut params: BTreeMap<String, String> = BTreeMap::new();
        params.insert("Format".into(), "JSON".into());
        params.insert("Version".into(), version.to_string());
        params.insert("AccessKeyId".into(), self.access_key_id.clone());
        params.insert("SignatureMethod".into(), "HMAC-SHA1".into());
        params.insert(
            "Timestamp".into(),
            Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        );
        params.insert("SignatureVersion".into(), "1.0".into());
        params.insert("SignatureNonce".into(), signature_nonce());
        params.insert("Action".into(), action.to_string());
        for (k, v) in extra {
            params.insert(k, v);
        }

        let canonical: String = params
            .iter()
            .map(|(k, v)| format!("{}={}", aliyun_percent_encode(k), aliyun_percent_encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        let string_to_sign = format!(
            "GET&{}&{}",
            aliyun_percent_encode("/"),
            aliyun_percent_encode(&canonical)
        );
        let signature = hmac_sha1_base64(&format!("{}&", self.access_key_secret), &string_to_sign)?;
        let url = format!(
            "{}?{}&Signature={}",
            endpoint.trim_end_matches('/'),
            canonical,
            aliyun_percent_encode(&signature)
        );

        let resp = http.get(&url).send().await.map_err(|e| {
            let mut detail = e.to_string();
            if let Some(src) = std::error::Error::source(&e) {
                detail = format!("{detail}; {src}");
            }
            OmniError::new(ErrorCode::Connection, format!("阿里云 {action} 请求失败"))
                .with_cause(detail)
        })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "读取阿里云响应失败").with_cause(e.to_string())
        })?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success()
            || body
                .get("Code")
                .and_then(|c| c.as_str())
                .is_some_and(|c| !c.is_empty() && c != "OK" && !c.eq_ignore_ascii_case("success"))
        {
            // 部分成功响应也可能带 Code=200 / 无 Code；仅在明确错误时失败。
            let code = body
                .get("Code")
                .and_then(|c| c.as_str())
                .or_else(|| body.get("code").and_then(|c| c.as_str()))
                .unwrap_or("");
            let message = body
                .get("Message")
                .and_then(|m| m.as_str())
                .or_else(|| body.get("message").and_then(|m| m.as_str()))
                .unwrap_or(text.trim());
            if !status.is_success()
                || (!code.is_empty()
                    && code != "200"
                    && !code.eq_ignore_ascii_case("ok")
                    && !code.eq_ignore_ascii_case("success"))
            {
                return Err(OmniError::new(
                    ErrorCode::Connection,
                    format!(
                        "阿里云 {action} 失败{}",
                        if code.is_empty() {
                            String::new()
                        } else {
                            format!(": {code}")
                        }
                    ),
                )
                .with_cause(message.to_string()));
            }
        }
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_arr_reads_aliyun_nested_instance_list() {
        let body = json!({
            "Instances": {
                "Instance": [
                    { "InstanceId": "i-1" },
                    { "InstanceId": "i-2" }
                ]
            },
            "TotalCount": 2
        });
        let items = json_arr(&body, &["Instances", "Instance"]);
        assert_eq!(items.len(), 2);
        assert_eq!(json_total_count(&body), 2);
    }

    #[test]
    fn json_arr_reads_describe_regions() {
        let body = json!({
            "Regions": {
                "Region": [
                    { "RegionId": "cn-hangzhou", "LocalName": "华东1（杭州）" },
                    { "RegionId": "cn-shanghai", "LocalName": "华东2（上海）" }
                ]
            }
        });
        let items = json_arr(&body, &["Regions", "Region"]);
        assert_eq!(items.len(), 2);
        assert_eq!(str_field(&items[1], &["RegionId"]), "cn-shanghai");
    }

    #[test]
    fn parse_ecs_reads_vpc_private_ip() {
        let item = json!({
            "InstanceId": "i-bp1",
            "InstanceName": "web",
            "Status": "Running",
            "RegionId": "cn-shanghai",
            "ZoneId": "cn-shanghai-f",
            "InstanceType": "ecs.t5",
            "PublicIpAddress": { "IpAddress": ["47.1.2.3"] },
            "InnerIpAddress": { "IpAddress": [] },
            "VpcAttributes": {
                "PrivateIpAddress": { "IpAddress": ["172.16.0.8"] }
            }
        });
        let parsed = parse_ecs_instance(&item);
        assert_eq!(parsed.instance_id, "i-bp1");
        assert_eq!(parsed.public_ip_address, "47.1.2.3");
        assert_eq!(parsed.private_ip_address, "172.16.0.8");
    }

    #[test]
    fn visible_regions_keep_occupied_and_configured() {
        let described = vec![
            CloudRegion {
                region_id: "cn-hangzhou".into(),
                local_name: "杭州".into(),
                has_ecs: false,
                has_swas: false,
            },
            CloudRegion {
                region_id: "cn-shanghai".into(),
                local_name: "上海".into(),
                has_ecs: false,
                has_swas: false,
            },
            CloudRegion {
                region_id: "cn-beijing".into(),
                local_name: "北京".into(),
                has_ecs: false,
                has_swas: false,
            },
            CloudRegion {
                region_id: "cn-shenzhen".into(),
                local_name: "深圳".into(),
                has_ecs: false,
                has_swas: false,
            },
        ];
        let occupied_ecs = HashSet::from(["cn-shanghai".to_string()]);
        let occupied_swas = HashSet::from(["cn-beijing".to_string()]);
        let out = select_visible_cloud_regions(
            described,
            &occupied_ecs,
            &occupied_swas,
            &["cn-hangzhou".into()],
            3,
        );
        let ids: Vec<_> = out.iter().map(|r| r.region_id.as_str()).collect();
        assert_eq!(ids, vec!["cn-hangzhou", "cn-shanghai", "cn-beijing"]);
        assert!(
            out.iter()
                .any(|r| r.region_id == "cn-shanghai" && r.has_ecs)
        );
        assert!(
            out.iter()
                .any(|r| r.region_id == "cn-beijing" && r.has_swas)
        );
    }

    #[test]
    fn visible_regions_show_all_when_occupied_empty() {
        let described = vec![
            CloudRegion {
                region_id: "cn-hangzhou".into(),
                local_name: "杭州".into(),
                has_ecs: false,
                has_swas: false,
            },
            CloudRegion {
                region_id: "cn-shanghai".into(),
                local_name: "上海".into(),
                has_ecs: false,
                has_swas: false,
            },
        ];
        let empty = HashSet::new();
        let out =
            select_visible_cloud_regions(described, &empty, &empty, &["cn-hangzhou".into()], 4);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn visible_regions_show_all_when_probes_fail() {
        let described = vec![
            CloudRegion {
                region_id: "cn-hangzhou".into(),
                local_name: "杭州".into(),
                has_ecs: false,
                has_swas: false,
            },
            CloudRegion {
                region_id: "cn-shanghai".into(),
                local_name: "上海".into(),
                has_ecs: false,
                has_swas: false,
            },
        ];
        let empty = HashSet::new();
        let out = select_visible_cloud_regions(described, &empty, &empty, &[], 0);
        assert_eq!(out.len(), 2);
    }
}
