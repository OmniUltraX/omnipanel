use std::collections::BTreeMap;

use crate::client::{
    CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket, CloudRegion as ClientRegion,
    CloudSwasInstance,
};
use crate::types::{
    CloudRegion, CloudResourceDetail, CloudResourceRow, CAP_CERTS, CAP_COMPUTE, CAP_COMPUTE_LITE,
    CAP_DOMAINS, CAP_OBJECT_STORAGE,
};

fn field_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

pub fn map_region(region: &ClientRegion) -> CloudRegion {
    let mut capabilities = Vec::new();
    if region.has_ecs {
        capabilities.push(CAP_COMPUTE.into());
    }
    if region.has_swas {
        capabilities.push(CAP_COMPUTE_LITE.into());
    }
    CloudRegion {
        region_id: region.region_id.clone(),
        local_name: region.local_name.clone(),
        capabilities,
    }
}

pub fn map_ecs_row(item: &CloudEcsInstance) -> CloudResourceRow {
    CloudResourceRow {
        id: item.instance_id.clone(),
        name: if item.instance_name.trim().is_empty() {
            item.instance_id.clone()
        } else {
            item.instance_name.clone()
        },
        capability: CAP_COMPUTE.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("publicIp", &item.public_ip_address),
            ("privateIp", &item.private_ip_address),
            ("instanceType", &item.instance_type),
            ("zone", &item.zone_id),
            ("os", &item.os_name),
            ("creationTime", &item.creation_time),
            ("expiredTime", &item.expired_time),
            ("autoReleaseTime", &item.auto_release_time),
            ("chargeType", &item.charge_type),
            ("securityGroups", &item.security_group_ids),
            ("cpu", &item.cpu),
            ("memory", &item.memory),
            ("hostname", &item.hostname),
            ("bandwidth", &item.bandwidth),
            ("vpcId", &item.vpc_id),
            ("keyPair", &item.key_pair_name),
        ]),
    }
}

pub fn map_swas_row(item: &CloudSwasInstance) -> CloudResourceRow {
    CloudResourceRow {
        id: item.instance_id.clone(),
        name: if item.instance_name.trim().is_empty() {
            item.instance_id.clone()
        } else {
            item.instance_name.clone()
        },
        capability: CAP_COMPUTE_LITE.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("publicIp", &item.public_ip_address),
            ("privateIp", &item.private_ip_address),
            ("plan", &item.instance_plan),
            ("imageId", &item.image_id),
            ("creationTime", &item.creation_time),
            ("expiredTime", &item.expired_time),
            ("chargeType", &item.charge_type),
            ("bandwidth", &item.bandwidth),
            ("diskSize", &item.disk_size),
        ]),
    }
}

pub fn map_oss_row(item: &CloudOssBucket) -> CloudResourceRow {
    let region = if item.region.trim().is_empty() {
        item.location.trim_start_matches("oss-").to_string()
    } else {
        item.region.trim_start_matches("oss-").to_string()
    };
    CloudResourceRow {
        id: item.name.clone(),
        name: item.name.clone(),
        capability: CAP_OBJECT_STORAGE.into(),
        region_id: region,
        status: item.storage_class.clone(),
        fields: field_map(&[
            ("storageClass", &item.storage_class),
            ("creationDate", &item.creation_date),
            ("endpoint", &item.extranet_endpoint),
            ("intranetEndpoint", &item.intranet_endpoint),
            ("location", &item.location),
        ]),
    }
}

pub fn map_domain_row(item: &CloudDomainItem) -> CloudResourceRow {
    let id = if item.domain_name.trim().is_empty() {
        item.instance_id.clone()
    } else {
        item.domain_name.clone()
    };
    CloudResourceRow {
        id: id.clone(),
        name: id,
        capability: CAP_DOMAINS.into(),
        region_id: String::new(),
        status: item.domain_status.clone(),
        fields: field_map(&[
            ("domain", &item.domain_name),
            ("type", &item.domain_type),
            ("registrationDate", &item.registration_date),
            ("expirationDate", &item.expiration_date),
            ("instanceId", &item.instance_id),
        ]),
    }
}

pub fn map_cert_row(item: &CloudCertificateItem) -> CloudResourceRow {
    let id = if item.order_id.trim().is_empty() {
        item.domain.clone()
    } else {
        item.order_id.clone()
    };
    CloudResourceRow {
        id,
        name: if item.name.trim().is_empty() {
            item.domain.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_CERTS.into(),
        region_id: String::new(),
        status: item.status.clone(),
        fields: field_map(&[
            ("domain", &item.domain),
            ("product", &item.product_name),
            ("certType", &item.cert_type),
            ("buyDate", &item.buy_date),
            ("endDate", &item.end_date),
        ]),
    }
}

fn console_ecs(region: &str, id: &str) -> String {
    format!("https://ecs.console.aliyun.com/server/{id}/detail?regionId={region}")
}

fn console_swas(region: &str, id: &str) -> String {
    format!("https://swasnext.console.aliyun.com/#/servers/{id}/detail?regionId={region}")
}

fn console_oss(region: &str, name: &str) -> String {
    let rid = if region.starts_with("oss-") {
        region.to_string()
    } else {
        format!("oss-{region}")
    };
    format!("https://oss.console.aliyun.com/bucket/{rid}/{name}/object")
}

fn console_domain(name: &str) -> String {
    format!("https://dc.console.aliyun.com/next/index#/domain/{name}")
}

fn console_cert() -> String {
    "https://yundun.console.aliyun.com/?p=cas".into()
}

pub fn ecs_to_detail(item: &CloudEcsInstance) -> CloudResourceDetail {
    let row = map_ecs_row(item);
    CloudResourceDetail {
        id: row.id.clone(),
        name: row.name.clone(),
        capability: row.capability.clone(),
        region_id: row.region_id.clone(),
        status: row.status.clone(),
        fields: row.fields,
        extra: serde_json::Value::Null,
        console_url: Some(console_ecs(&row.region_id, &row.id)),
    }
}

pub fn swas_to_detail(item: &CloudSwasInstance) -> CloudResourceDetail {
    let row = map_swas_row(item);
    CloudResourceDetail {
        id: row.id.clone(),
        name: row.name.clone(),
        capability: row.capability.clone(),
        region_id: row.region_id.clone(),
        status: row.status.clone(),
        fields: row.fields,
        extra: serde_json::Value::Null,
        console_url: Some(console_swas(&row.region_id, &row.id)),
    }
}

pub fn oss_to_detail(item: &CloudOssBucket) -> CloudResourceDetail {
    let row = map_oss_row(item);
    CloudResourceDetail {
        id: row.id.clone(),
        name: row.name.clone(),
        capability: row.capability.clone(),
        region_id: row.region_id.clone(),
        status: row.status.clone(),
        fields: row.fields,
        extra: serde_json::Value::Null,
        console_url: Some(console_oss(&row.region_id, &row.id)),
    }
}

pub fn domain_to_detail(item: &CloudDomainItem) -> CloudResourceDetail {
    let row = map_domain_row(item);
    CloudResourceDetail {
        id: row.id.clone(),
        name: row.name.clone(),
        capability: row.capability.clone(),
        region_id: row.region_id.clone(),
        status: row.status.clone(),
        fields: row.fields,
        extra: serde_json::Value::Null,
        console_url: Some(console_domain(&row.id)),
    }
}

pub fn cert_to_detail(item: &CloudCertificateItem) -> CloudResourceDetail {
    let row = map_cert_row(item);
    CloudResourceDetail {
        id: row.id.clone(),
        name: row.name.clone(),
        capability: row.capability.clone(),
        region_id: row.region_id.clone(),
        status: row.status.clone(),
        fields: row.fields,
        extra: serde_json::Value::Null,
        console_url: Some(console_cert()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ecs_fixture() -> CloudEcsInstance {
        CloudEcsInstance {
            instance_id: "i-bp1".into(),
            instance_name: "web".into(),
            status: "Running".into(),
            region_id: "cn-hangzhou".into(),
            zone_id: "cn-hangzhou-i".into(),
            instance_type: "ecs.t5".into(),
            public_ip_address: "47.1.2.3".into(),
            private_ip_address: "172.16.0.8".into(),
            os_name: "Alibaba Cloud Linux".into(),
            creation_time: "2024-01-01T00:00:00Z".into(),
            expired_time: "2026-12-01T00:00:00Z".into(),
            auto_release_time: String::new(),
            charge_type: "PrePaid".into(),
            security_group_ids: "sg-1,sg-2".into(),
            cpu: "2".into(),
            memory: "4 GiB".into(),
            hostname: "web".into(),
            bandwidth: "100".into(),
            vpc_id: "vpc-1".into(),
            key_pair_name: String::new(),
        }
    }

    #[test]
    fn ecs_maps_to_compute() {
        let row = map_ecs_row(&ecs_fixture());
        assert_eq!(row.capability, CAP_COMPUTE);
        assert_eq!(row.id, "i-bp1");
        assert_eq!(row.fields.get("publicIp").map(String::as_str), Some("47.1.2.3"));
        assert_eq!(row.fields.get("instanceType").map(String::as_str), Some("ecs.t5"));
        assert_eq!(row.fields.get("expiredTime").map(String::as_str), Some("2026-12-01T00:00:00Z"));
        assert_eq!(row.fields.get("securityGroups").map(String::as_str), Some("sg-1,sg-2"));
        let detail = ecs_to_detail(&ecs_fixture());
        assert!(detail.console_url.unwrap().contains("i-bp1"));
    }

    #[test]
    fn swas_maps_to_compute_lite() {
        let item = CloudSwasInstance {
            instance_id: "s-1".into(),
            instance_name: "lite".into(),
            status: "Running".into(),
            region_id: "cn-shanghai".into(),
            public_ip_address: "1.1.1.1".into(),
            private_ip_address: "10.0.0.2".into(),
            image_id: "img-1".into(),
            instance_plan: "swas.s2.c2m2".into(),
            creation_time: String::new(),
            expired_time: "2026-06-01T00:00:00Z".into(),
            charge_type: "PrePaid".into(),
            bandwidth: "3".into(),
            disk_size: "40".into(),
        };
        let row = map_swas_row(&item);
        assert_eq!(row.capability, CAP_COMPUTE_LITE);
        assert_eq!(row.fields.get("plan").map(String::as_str), Some("swas.s2.c2m2"));
        assert_eq!(row.fields.get("imageId").map(String::as_str), Some("img-1"));
    }

    #[test]
    fn oss_strips_oss_prefix() {
        let item = CloudOssBucket {
            name: "my-bucket".into(),
            location: "oss-cn-hangzhou".into(),
            creation_date: "2020-01-01".into(),
            storage_class: "Standard".into(),
            extranet_endpoint: "oss-cn-hangzhou.aliyuncs.com".into(),
            intranet_endpoint: String::new(),
            region: String::new(),
        };
        let row = map_oss_row(&item);
        assert_eq!(row.capability, CAP_OBJECT_STORAGE);
        assert_eq!(row.region_id, "cn-hangzhou");
    }

    #[test]
    fn region_capabilities_from_occupancy() {
        let mapped = map_region(&ClientRegion {
            region_id: "cn-beijing".into(),
            local_name: "北京".into(),
            has_ecs: true,
            has_swas: true,
        });
        assert_eq!(mapped.capabilities, vec![CAP_COMPUTE, CAP_COMPUTE_LITE]);
    }
}
