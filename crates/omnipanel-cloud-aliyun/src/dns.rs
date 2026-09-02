//! 云解析 DNS：托管区与解析记录。

use std::collections::BTreeMap;

use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::{CloudAction, CloudChildRow};

const ENDPOINT: &str = "https://alidns.aliyuncs.com/";
const VERSION: &str = "2015-01-09";

#[derive(Debug, Clone, Default)]
pub struct CloudDnsZone {
    pub domain_name: String,
    pub record_count: String,
    pub dns_servers: String,
    pub version_code: String,
}

fn child_fields(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

fn parse_record(item: &Value) -> CloudChildRow {
    CloudChildRow {
        id: str_field(item, &["RecordId"]),
        kind: "dnsRecord".into(),
        name: str_field(item, &["RR"]),
        status: str_field(item, &["Status"]),
        fields: child_fields(&[
            ("type", str_field(item, &["Type"])),
            ("value", str_field(item, &["Value"])),
            ("ttl", str_field(item, &["TTL"])),
            ("line", str_field(item, &["Line"])),
            ("priority", str_field(item, &["Priority"])),
        ]),
    }
}

impl AliyunCredentials {
    pub async fn list_dns_zones(&self, http: &Client) -> Result<Vec<CloudDnsZone>, OmniError> {
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "100".into());
            let body = self
                .rpc_call(http, ENDPOINT, VERSION, "DescribeDomains", params)
                .await?;
            let items = json_list(&body, "Domains", "Domain");
            let count = items.len();
            out.extend(items.iter().map(|item| CloudDnsZone {
                domain_name: str_field(item, &["DomainName"]),
                record_count: str_field(item, &["RecordCount"]),
                dns_servers: str_field(item, &["DnsServers"]),
                version_code: str_field(item, &["VersionCode", "VersionName"]),
            }));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_dns_zone(
        &self,
        http: &Client,
        domain: &str,
    ) -> Result<Option<CloudDnsZone>, OmniError> {
        let name = domain.trim();
        if name.is_empty() {
            return Ok(None);
        }
        let mut params = BTreeMap::new();
        params.insert("DomainName".into(), name.to_string());
        let body = self
            .rpc_call(http, ENDPOINT, VERSION, "DescribeDomainInfo", params)
            .await?;
        let domain_name = str_field(&body, &["DomainName"]);
        if domain_name.is_empty() {
            return Ok(None);
        }
        Ok(Some(CloudDnsZone {
            domain_name,
            record_count: str_field(&body, &["RecordCount"]),
            dns_servers: str_field(&body, &["DnsServers"]),
            version_code: str_field(&body, &["VersionCode", "VersionName"]),
        }))
    }

    pub async fn list_dns_records(
        &self,
        http: &Client,
        domain: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("DomainName".into(), domain.trim().to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "100".into());
            let body = self
                .rpc_call(http, ENDPOINT, VERSION, "DescribeDomainRecords", params)
                .await?;
            let items = json_list(&body, "DomainRecords", "Record");
            let count = items.len();
            out.extend(items.iter().map(parse_record));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn add_dns_record(&self, http: &Client, action: &CloudAction) -> Result<(), OmniError> {
        let rr = action.param("rr");
        let rtype = action.param("type");
        let value = action.param("value");
        if rr.is_empty() || rtype.is_empty() || value.is_empty() {
            return Err(OmniError::invalid_input("解析记录需要主机记录、类型与记录值"));
        }
        let mut params = BTreeMap::new();
        params.insert("DomainName".into(), action.resource_id.trim().to_string());
        params.insert("RR".into(), rr);
        params.insert("Type".into(), rtype.to_ascii_uppercase());
        params.insert("Value".into(), value);
        if let Some(ttl) = nonempty(action.param("ttl")) {
            params.insert("TTL".into(), ttl);
        }
        if let Some(line) = nonempty(action.param("line")) {
            params.insert("Line".into(), line);
        }
        let _ = self
            .rpc_call(http, ENDPOINT, VERSION, "AddDomainRecord", params)
            .await?;
        Ok(())
    }

    pub async fn update_dns_record(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let record_id = action.param("recordId");
        if record_id.is_empty() {
            return Err(OmniError::invalid_input("缺少记录 id"));
        }
        let mut params = BTreeMap::new();
        params.insert("RecordId".into(), record_id);
        params.insert("RR".into(), nonempty_or(action.param("rr"), "@"));
        params.insert(
            "Type".into(),
            nonempty_or(action.param("type").to_ascii_uppercase(), "A"),
        );
        params.insert("Value".into(), action.param("value"));
        if let Some(ttl) = nonempty(action.param("ttl")) {
            params.insert("TTL".into(), ttl);
        }
        let _ = self
            .rpc_call(http, ENDPOINT, VERSION, "UpdateDomainRecord", params)
            .await?;
        Ok(())
    }

    pub async fn delete_dns_record(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let record_id = action.param("recordId");
        if record_id.is_empty() {
            return Err(OmniError::invalid_input("缺少记录 id"));
        }
        let mut params = BTreeMap::new();
        params.insert("RecordId".into(), record_id);
        let _ = self
            .rpc_call(http, ENDPOINT, VERSION, "DeleteDomainRecord", params)
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

fn nonempty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_record() {
        let row = parse_record(&json!({
            "RecordId": "1",
            "RR": "www",
            "Type": "A",
            "Value": "1.2.3.4",
            "TTL": 600,
            "Status": "ENABLE"
        }));
        assert_eq!(row.name, "www");
        assert_eq!(row.fields.get("value").map(String::as_str), Some("1.2.3.4"));
    }
}
