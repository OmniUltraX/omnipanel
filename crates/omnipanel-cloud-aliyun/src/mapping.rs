use std::collections::BTreeMap;

use crate::client::{
    CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket, CloudRegion as ClientRegion,
    CloudSwasInstance,
};
use crate::disk::CloudDisk;
use crate::dns::CloudDnsZone;
use crate::eip::CloudEip;
use crate::kvstore::CloudKvInstance;
use crate::metrics::{
    ECS_METRIC_IDS, EIP_METRIC_IDS, KV_METRIC_IDS, RDS_METRIC_IDS, SLB_METRIC_IDS, SWAS_METRIC_IDS,
};
use crate::rds::CloudRdsInstance;
use crate::security_group::CloudSecurityGroup;
use crate::slb::CloudLoadBalancer;
use crate::types::{
    CloudChildRow, CloudRelatedRef, CloudRegion, CloudResourceDetail, CloudResourceRow, CAP_CERTS,
    CAP_COMPUTE,
    CAP_COMPUTE_LITE, CAP_DATABASE, CAP_DATABASE_CACHE, CAP_DOMAINS, CAP_LOAD_BALANCER,
    CAP_NETWORK_EIP, CAP_OBJECT_STORAGE, CAP_SECURITY_GROUP, CAP_STORAGE_DISK,
};

fn related_vpc(vpc_id: &str) -> Option<CloudRelatedRef> {
    let id = vpc_id.trim();
    if id.is_empty() {
        return None;
    }
    Some(CloudRelatedRef {
        capability: String::new(),
        resource_id: id.to_string(),
        name: id.to_string(),
        role: "vpc".into(),
    })
}

fn related_bound_instance(instance_id: &str, instance_type: &str) -> Option<CloudRelatedRef> {
    let id = instance_id.trim();
    if id.is_empty() {
        return None;
    }
    let capability = match instance_type.trim() {
        "SlbInstance" | "Slb" => CAP_LOAD_BALANCER,
        "EcsInstance" | "Ecs" | "" => CAP_COMPUTE,
        _ => "",
    };
    Some(CloudRelatedRef {
        capability: capability.into(),
        resource_id: id.to_string(),
        name: id.to_string(),
        role: "instance".into(),
    })
}

fn related_security_groups(ids: &str) -> Vec<CloudRelatedRef> {
    ids.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|id| CloudRelatedRef {
            capability: CAP_SECURITY_GROUP.into(),
            resource_id: id.to_string(),
            name: id.to_string(),
            role: "securityGroup".into(),
        })
        .collect()
}

fn metric_ids(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| (*s).to_string()).collect()
}

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
    let mut detail = CloudResourceDetail::from_row(
        map_ecs_row(item),
        Some(console_ecs(&item.region_id, &item.instance_id)),
    );
    detail.related = related_security_groups(&item.security_group_ids);
    if let Some(vpc) = related_vpc(&item.vpc_id) {
        detail.related.push(vpc);
    }
    detail.metric_ids = metric_ids(ECS_METRIC_IDS);
    detail
}

pub fn swas_to_detail(item: &CloudSwasInstance) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_swas_row(item),
        Some(console_swas(&item.region_id, &item.instance_id)),
    );
    detail.metric_ids = metric_ids(SWAS_METRIC_IDS);
    detail
}

pub fn oss_to_detail(item: &CloudOssBucket) -> CloudResourceDetail {
    let row = map_oss_row(item);
    CloudResourceDetail::from_row(row.clone(), Some(console_oss(&row.region_id, &row.id)))
}

pub fn domain_to_detail(item: &CloudDomainItem) -> CloudResourceDetail {
    CloudResourceDetail::from_row(map_domain_row(item), Some(console_domain(&item.domain_name)))
}

pub fn cert_to_detail(item: &CloudCertificateItem) -> CloudResourceDetail {
    CloudResourceDetail::from_row(map_cert_row(item), Some(console_cert()))
}

pub fn map_sg_row(item: &CloudSecurityGroup) -> CloudResourceRow {
    CloudResourceRow {
        id: item.group_id.clone(),
        name: if item.name.trim().is_empty() {
            item.group_id.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_SECURITY_GROUP.into(),
        region_id: item.region_id.clone(),
        status: if item.vpc_id.is_empty() {
            "classic".into()
        } else {
            "vpc".into()
        },
        fields: field_map(&[
            ("vpcId", &item.vpc_id),
            ("description", &item.description),
            ("creationTime", &item.creation_time),
            ("ruleCount", &item.rules.len().to_string()),
            ("instanceCount", &item.instance_count),
        ]),
    }
}

pub fn sg_to_detail(item: &CloudSecurityGroup) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_sg_row(item),
        Some(console_sg(&item.region_id, &item.group_id)),
    );
    detail.rules = item.rules.clone();
    detail
}

pub fn map_rds_row(item: &CloudRdsInstance) -> CloudResourceRow {
    CloudResourceRow {
        id: item.instance_id.clone(),
        name: if item.name.trim().is_empty() {
            item.instance_id.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_DATABASE.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("engine", &item.engine),
            ("engineVersion", &item.engine_version),
            ("instanceClass", &item.instance_class),
            ("storage", &item.storage),
            ("zone", &item.zone),
            ("connectionString", &item.connection_string),
            ("port", &item.port),
            ("vpcId", &item.vpc_id),
            ("chargeType", &item.charge_type),
            ("expiredTime", &item.expired_time),
            ("networkType", &item.network_type),
        ]),
    }
}

pub fn rds_to_detail(item: &CloudRdsInstance) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_rds_row(item),
        Some(console_rds(&item.region_id, &item.instance_id)),
    );
    detail.metric_ids = metric_ids(RDS_METRIC_IDS);
    detail.log_kinds = vec!["slow".into()];
    if let Some(vpc) = related_vpc(&item.vpc_id) {
        detail.related.push(vpc);
    }
    detail
}

pub fn map_dns_row(item: &CloudDnsZone) -> CloudResourceRow {
    CloudResourceRow {
        id: item.domain_name.clone(),
        name: item.domain_name.clone(),
        capability: CAP_DOMAINS.into(),
        region_id: String::new(),
        status: item.version_code.clone(),
        fields: field_map(&[
            ("domain", &item.domain_name),
            ("recordCount", &item.record_count),
            ("dnsServers", &item.dns_servers),
            ("type", &item.version_code),
        ]),
    }
}

pub fn dns_to_detail(item: &CloudDnsZone) -> CloudResourceDetail {
    CloudResourceDetail::from_row(
        map_dns_row(item),
        Some(format!(
            "https://dns.console.aliyun.com/#/dns/resolve/{}/records",
            item.domain_name
        )),
    )
}

fn overlay_dns_fields(row: &mut CloudResourceRow, zone: &CloudDnsZone) {
    if !zone.record_count.is_empty() {
        row.fields.insert("recordCount".into(), zone.record_count.clone());
    }
    if !zone.dns_servers.is_empty() {
        row.fields.insert("dnsServers".into(), zone.dns_servers.clone());
    }
    if row.status.trim().is_empty() && !zone.version_code.is_empty() {
        row.status = zone.version_code.clone();
    }
}

/// 注册域名 ∪ 解析托管区，同一域名只出现一次。
pub fn merge_domain_rows(regs: &[CloudDomainItem], zones: &[CloudDnsZone]) -> Vec<CloudResourceRow> {
    let mut rows: Vec<CloudResourceRow> = regs.iter().map(map_domain_row).collect();
    for zone in zones {
        let name = zone.domain_name.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(row) = rows.iter_mut().find(|row| {
            row.id.eq_ignore_ascii_case(name) || row.name.eq_ignore_ascii_case(name)
        }) {
            overlay_dns_fields(row, zone);
        } else {
            rows.push(map_dns_row(zone));
        }
    }
    rows
}

pub fn merged_domain_detail(
    reg: Option<&CloudDomainItem>,
    zone: Option<&CloudDnsZone>,
) -> Option<CloudResourceDetail> {
    let mut detail = if let Some(item) = reg {
        domain_to_detail(item)
    } else if let Some(item) = zone {
        dns_to_detail(item)
    } else {
        return None;
    };
    if let Some(item) = zone {
        overlay_dns_fields_on_detail(&mut detail, item);
        if detail.console_url.is_none() {
            detail.console_url = Some(format!(
                "https://dns.console.aliyun.com/#/dns/resolve/{}/records",
                item.domain_name
            ));
        }
    }
    Some(detail)
}

fn overlay_dns_fields_on_detail(detail: &mut CloudResourceDetail, zone: &CloudDnsZone) {
    if !zone.record_count.is_empty() {
        detail.fields.insert("recordCount".into(), zone.record_count.clone());
    }
    if !zone.dns_servers.is_empty() {
        detail.fields.insert("dnsServers".into(), zone.dns_servers.clone());
    }
}

pub fn map_kv_row(item: &CloudKvInstance) -> CloudResourceRow {
    CloudResourceRow {
        id: item.instance_id.clone(),
        name: if item.name.trim().is_empty() {
            item.instance_id.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_DATABASE_CACHE.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("engine", &item.engine),
            ("engineVersion", &item.engine_version),
            ("instanceClass", &item.instance_class),
            ("capacity", &item.capacity),
            ("zone", &item.zone),
            ("connectionString", &item.connection_string),
            ("port", &item.port),
            ("vpcId", &item.vpc_id),
            ("chargeType", &item.charge_type),
            ("expiredTime", &item.expired_time),
        ]),
    }
}

pub fn kv_to_detail(item: &CloudKvInstance) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_kv_row(item),
        Some(console_kv(&item.region_id, &item.instance_id)),
    );
    detail.metric_ids = metric_ids(KV_METRIC_IDS);
    detail.log_kinds = vec!["slow".into()];
    if let Some(vpc) = related_vpc(&item.vpc_id) {
        detail.related.push(vpc);
    }
    detail
}

pub fn map_eip_row(item: &CloudEip) -> CloudResourceRow {
    CloudResourceRow {
        id: item.allocation_id.clone(),
        name: if item.name.trim().is_empty() {
            item.ip.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_NETWORK_EIP.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("publicIp", &item.ip),
            ("bandwidth", &item.bandwidth),
            ("instanceId", &item.instance_id),
            ("instanceType", &item.instance_type),
            ("chargeType", &item.charge_type),
        ]),
    }
}

pub fn eip_to_detail(item: &CloudEip) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_eip_row(item),
        Some(console_eip(&item.region_id, &item.allocation_id)),
    );
    detail.metric_ids = metric_ids(EIP_METRIC_IDS);
    if let Some(bound) = related_bound_instance(&item.instance_id, &item.instance_type) {
        detail.related.push(bound);
    }
    detail
}

pub fn map_lb_row(item: &CloudLoadBalancer) -> CloudResourceRow {
    CloudResourceRow {
        id: item.id.clone(),
        name: if item.name.trim().is_empty() {
            item.id.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_LOAD_BALANCER.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("publicIp", &item.address),
            ("addressType", &item.address_type),
            ("instanceClass", &item.spec),
            ("bandwidth", &item.bandwidth),
            ("vpcId", &item.vpc_id),
        ]),
    }
}

pub fn lb_to_detail(item: &CloudLoadBalancer) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_lb_row(item),
        Some(console_slb(&item.region_id, &item.id)),
    );
    detail.metric_ids = metric_ids(SLB_METRIC_IDS);
    detail.children = item
        .listeners
        .iter()
        .cloned()
        .chain(item.backends.iter().cloned())
        .collect();
    if let Some(vpc) = related_vpc(&item.vpc_id) {
        detail.related.push(vpc);
    }
    detail
}

pub fn map_disk_row(item: &CloudDisk) -> CloudResourceRow {
    CloudResourceRow {
        id: item.disk_id.clone(),
        name: if item.name.trim().is_empty() {
            item.disk_id.clone()
        } else {
            item.name.clone()
        },
        capability: CAP_STORAGE_DISK.into(),
        region_id: item.region_id.clone(),
        status: item.status.clone(),
        fields: field_map(&[
            ("size", &item.size),
            ("category", &item.category),
            ("type", &item.disk_type),
            ("zone", &item.zone),
            ("instanceId", &item.instance_id),
            ("chargeType", &item.charge_type),
        ]),
    }
}

pub fn disk_display_name(item: &CloudDisk) -> String {
    let name = if item.name.trim().is_empty() {
        item.disk_id.as_str()
    } else {
        item.name.as_str()
    };
    let mut parts = vec![name.to_string()];
    if !item.size.trim().is_empty() {
        let size = item.size.trim();
        parts.push(if size.to_ascii_lowercase().ends_with("gb") {
            size.to_string()
        } else {
            format!("{size}GB")
        });
    }
    if !item.disk_type.trim().is_empty() {
        parts.push(item.disk_type.clone());
    } else if !item.category.trim().is_empty() {
        parts.push(item.category.clone());
    }
    parts.join(" · ")
}

pub fn attach_instance_disks(detail: &mut CloudResourceDetail, disks: &[CloudDisk]) {
    if !disks.is_empty() {
        detail
            .fields
            .insert("diskCount".into(), disks.len().to_string());
    }
    for disk in disks {
        detail.related.push(CloudRelatedRef {
            capability: CAP_STORAGE_DISK.into(),
            resource_id: disk.disk_id.clone(),
            name: disk_display_name(disk),
            role: "disk".into(),
        });
    }
}

pub fn attach_instance_snapshots(detail: &mut CloudResourceDetail, snapshots: Vec<CloudChildRow>) {
    if !snapshots.is_empty() {
        detail
            .fields
            .insert("snapshotCount".into(), snapshots.len().to_string());
    }
    detail.children.extend(snapshots);
}

pub fn disk_to_detail(item: &CloudDisk) -> CloudResourceDetail {
    let mut detail = CloudResourceDetail::from_row(
        map_disk_row(item),
        Some(console_disk(&item.region_id, &item.disk_id)),
    );
    detail.children = item.snapshots.clone();
    if !item.instance_id.is_empty() {
        detail.related.push(CloudRelatedRef {
            capability: CAP_COMPUTE.into(),
            resource_id: item.instance_id.clone(),
            name: item.instance_id.clone(),
            role: "instance".into(),
        });
    }
    detail
}

fn console_kv(region: &str, id: &str) -> String {
    format!("https://kvstore.console.aliyun.com/Redis/instance/{id}?regionId={region}")
}

fn console_eip(region: &str, id: &str) -> String {
    format!("https://vpcnext.console.aliyun.com/vpc/{region}/eips/{id}")
}

fn console_slb(region: &str, id: &str) -> String {
    format!("https://slb.console.aliyun.com/slb/{region}/slbs/{id}")
}

fn console_disk(region: &str, id: &str) -> String {
    format!("https://ecs.console.aliyun.com/disk/{id}/detail?regionId={region}")
}

fn console_sg(region: &str, id: &str) -> String {
    format!("https://ecs.console.aliyun.com/securityGroup/region/{region}/detail/{id}/detail")
}

fn console_rds(region: &str, id: &str) -> String {
    format!("https://rdsnext.console.aliyun.com/detail/{id}/basicInfo?regionId={region}")
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

    #[test]
    fn merges_registration_and_dns_zone() {
        let regs = [CloudDomainItem {
            domain_name: "example.com".into(),
            instance_id: "d-1".into(),
            registration_date: "2020-01-01".into(),
            expiration_date: "2027-01-01".into(),
            domain_status: "1".into(),
            domain_type: "NewGtld".into(),
        }];
        let zones = [
            CloudDnsZone {
                domain_name: "example.com".into(),
                record_count: "12".into(),
                dns_servers: "dns1.aliyun.com".into(),
                version_code: "enterprise".into(),
            },
            CloudDnsZone {
                domain_name: "only-dns.com".into(),
                record_count: "3".into(),
                dns_servers: String::new(),
                version_code: String::new(),
            },
        ];
        let rows = merge_domain_rows(&regs, &zones);
        assert_eq!(rows.len(), 2);
        let registered = rows.iter().find(|r| r.id == "example.com").unwrap();
        assert_eq!(registered.capability, CAP_DOMAINS);
        assert_eq!(registered.fields.get("expirationDate").map(String::as_str), Some("2027-01-01"));
        assert_eq!(registered.fields.get("recordCount").map(String::as_str), Some("12"));
        assert!(rows.iter().any(|r| r.id == "only-dns.com"));
    }

    #[test]
    fn eip_related_follows_instance_type() {
        let ecs = eip_to_detail(&CloudEip {
            allocation_id: "eip-1".into(),
            ip: "1.1.1.1".into(),
            instance_id: "i-1".into(),
            instance_type: "EcsInstance".into(),
            ..CloudEip::default()
        });
        assert_eq!(ecs.related[0].capability, CAP_COMPUTE);
        let slb = eip_to_detail(&CloudEip {
            allocation_id: "eip-2".into(),
            ip: "1.1.1.2".into(),
            instance_id: "lb-1".into(),
            instance_type: "SlbInstance".into(),
            ..CloudEip::default()
        });
        assert_eq!(slb.related[0].capability, CAP_LOAD_BALANCER);
    }

    #[test]
    fn instance_disks_show_size_and_count() {
        let mut detail = ecs_to_detail(&ecs_fixture());
        attach_instance_disks(
            &mut detail,
            &[CloudDisk {
                disk_id: "d-1".into(),
                name: "sys".into(),
                size: "40".into(),
                disk_type: "system".into(),
                ..CloudDisk::default()
            }],
        );
        assert_eq!(detail.fields.get("diskCount").map(String::as_str), Some("1"));
        let disk = detail
            .related
            .iter()
            .find(|item| item.role == "disk")
            .expect("disk related");
        assert_eq!(disk.resource_id, "d-1");
        assert_eq!(disk.name, "sys · 40GB · system");
    }
}
