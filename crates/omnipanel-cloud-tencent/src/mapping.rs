use std::collections::BTreeMap;

use omnipanel_cloud_aliyun::{
    CloudChildRow, CloudLogEntry, CloudLogPage, CloudMetricPoint, CloudMetricSeries,
    CloudNetworkRule, CloudRelatedRef, CloudRegion, CloudResourceDetail, CloudResourceRow,
    CAP_CERTS, CAP_COMPUTE, CAP_COMPUTE_LITE, CAP_DATABASE, CAP_DATABASE_CACHE, CAP_DOMAINS,
    CAP_LOAD_BALANCER, CAP_NETWORK_EIP, CAP_OBJECT_STORAGE, CAP_SECURITY_GROUP, CAP_STORAGE_DISK,
};
use serde_json::Value;

use crate::client::{jarr, jips, jstr};

pub const COMPUTE_METRIC_IDS: &[&str] = &[
    "CPUUtilization",
    "memory_usedutilization",
    "InternetInRate",
    "InternetOutRate",
    "DiskReadBPS",
    "DiskWriteBPS",
];

pub const RDS_METRIC_IDS: &[&str] = &[
    "CPUUtilization",
    "memory_usedutilization",
    "DiskReadBPS",
    "DiskWriteBPS",
];

pub const KV_METRIC_IDS: &[&str] = &[
    "CPUUtilization",
    "memory_usedutilization",
    "InternetInRate",
    "InternetOutRate",
];

pub const EIP_METRIC_IDS: &[&str] = &["InternetInRate", "InternetOutRate"];

pub const LB_METRIC_IDS: &[&str] = &["InternetInRate", "InternetOutRate"];

pub fn map_instance_status(raw: &str) -> String {
    match raw.trim().to_ascii_uppercase().as_str() {
        "RUNNING" | "ONLINE" | "NORMAL" | "AVAILABLE" => "RUNNING".into(),
        "STOPPED" | "OFFLINE" | "SHUTDOWN" | "ISOLATED" => "STOPPED".into(),
        "PENDING" | "STARTING" | "LAUNCHING" | "CREATING" => "PENDING".into(),
        "STOPPING" | "SHUTTING_DOWN" => "STOPPING".into(),
        "REBOOTING" | "RESTARTING" => "REBOOTING".into(),
        other => {
            if other.parse::<i64>() == Ok(1) || other.parse::<i64>() == Ok(2) {
                "RUNNING".into()
            } else if other.parse::<i64>() == Ok(0)
                || other.parse::<i64>() == Ok(4)
                || other.parse::<i64>() == Ok(5)
                || other.parse::<i64>() == Ok(-2)
            {
                "STOPPED".into()
            } else {
                raw.trim().to_string()
            }
        }
    }
}

fn field_map(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

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

fn related_security_groups(ids: &str) -> Vec<CloudRelatedRef> {
    ids.split(',')
        .map(str::trim)
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

fn display_name(name: &str, fallback: &str) -> String {
    if name.trim().is_empty() {
        fallback.to_string()
    } else {
        name.to_string()
    }
}

fn region_of(item: &Value, fallback: &str) -> String {
    let id = jstr(item, &["Region", "RegionId"]);
    if id.is_empty() {
        fallback.to_string()
    } else {
        id
    }
}

fn zone_of(item: &Value) -> String {
    let direct = jstr(item, &["Zone", "ZoneId"]);
    if !direct.is_empty() {
        return direct;
    }
    item.get("Placement")
        .map(|p| jstr(p, &["Zone"]))
        .unwrap_or_default()
}

fn vpc_of(item: &Value) -> String {
    let direct = jstr(item, &["VpcId", "UniqVpcId", "VirtualPrivateCloudId"]);
    if !direct.is_empty() {
        return direct;
    }
    item.get("VirtualPrivateCloud")
        .map(|p| jstr(p, &["VpcId"]))
        .unwrap_or_default()
}

fn sg_ids(item: &Value) -> String {
    let joined = jips(item, &["SecurityGroupIds"]);
    if !joined.is_empty() {
        return joined;
    }
    jstr(item, &["SecurityGroupIds"])
}

pub fn map_region_row(item: &Value) -> Option<CloudRegion> {
    let region_id = jstr(item, &["Region", "RegionId"]);
    if region_id.is_empty() {
        return None;
    }
    Some(CloudRegion {
        region_id,
        local_name: jstr(item, &["RegionName", "LocalName"]),
        capabilities: Vec::new(),
    })
}

pub fn map_cvm_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["InstanceId"]);
    let public_ip = jips(item, &["PublicIpAddresses", "PublicIpAddress"]);
    let private_ip = jips(item, &["PrivateIpAddresses", "PrivateIpAddress"]);
    let bandwidth = item
        .get("InternetAccessible")
        .map(|p| jstr(p, &["InternetMaxBandwidthOut"]))
        .unwrap_or_default();
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["InstanceName"]), &id),
        capability: CAP_COMPUTE.into(),
        region_id: region_of(item, region),
        status: map_instance_status(&jstr(item, &["InstanceState", "Status"])),
        fields: field_map(&[
            ("publicIp", public_ip),
            ("privateIp", private_ip),
            ("instanceType", jstr(item, &["InstanceType"])),
            ("zone", zone_of(item)),
            ("os", jstr(item, &["OsName", "ImageId"])),
            ("creationTime", jstr(item, &["CreatedTime", "CreationTime"])),
            ("expiredTime", jstr(item, &["ExpiredTime"])),
            ("chargeType", jstr(item, &["InstanceChargeType", "ChargeType"])),
            ("securityGroups", sg_ids(item)),
            ("cpu", jstr(item, &["CPU", "Cpu"])),
            ("memory", jstr(item, &["Memory"])),
            ("hostname", jstr(item, &["Uuid", "InstanceName"])),
            ("bandwidth", bandwidth),
            ("vpcId", vpc_of(item)),
        ]),
    }
}

pub fn cvm_to_detail(item: &Value, region: &str) -> CloudResourceDetail {
    let row = map_cvm_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/cvm/instance/detail?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.related = related_security_groups(detail.fields.get("securityGroups").map(String::as_str).unwrap_or(""));
    if let Some(vpc) = related_vpc(detail.fields.get("vpcId").map(String::as_str).unwrap_or("")) {
        detail.related.push(vpc);
    }
    detail.metric_ids = metric_ids(COMPUTE_METRIC_IDS);
    detail.extra = item.clone();
    detail
}

pub fn map_lighthouse_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["InstanceId"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["InstanceName"]), &id),
        capability: CAP_COMPUTE_LITE.into(),
        region_id: region_of(item, region),
        status: map_instance_status(&jstr(item, &["InstanceState", "Status"])),
        fields: field_map(&[
            (
                "publicIp",
                jips(item, &["PublicAddresses", "PublicIpAddresses"]),
            ),
            (
                "privateIp",
                jips(item, &["PrivateAddresses", "PrivateIpAddresses"]),
            ),
            ("plan", jstr(item, &["BundleId", "InstanceType"])),
            ("imageId", jstr(item, &["BlueprintId", "ImageId"])),
            ("creationTime", jstr(item, &["CreatedTime"])),
            ("expiredTime", jstr(item, &["ExpiredTime"])),
            ("chargeType", jstr(item, &["InstanceChargeType"])),
            (
                "bandwidth",
                item.get("InternetAccessible")
                    .map(|p| jstr(p, &["InternetMaxBandwidthOut"]))
                    .unwrap_or_else(|| jstr(item, &["InternetMaxBandwidthOut"])),
            ),
            (
                "diskSize",
                item.get("SystemDisk")
                    .map(|p| jstr(p, &["DiskSize"]))
                    .unwrap_or_default(),
            ),
            ("zone", zone_of(item)),
        ]),
    }
}

pub fn lighthouse_to_detail(item: &Value, region: &str) -> CloudResourceDetail {
    let row = map_lighthouse_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/lighthouse/instance/detail?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.metric_ids = metric_ids(COMPUTE_METRIC_IDS);
    detail.extra = item.clone();
    detail
}

pub fn map_firewall_rule(item: &Value) -> CloudNetworkRule {
    CloudNetworkRule {
        id: jstr(item, &["FirewallRuleId", "Id"]),
        direction: "ingress".into(),
        protocol: jstr(item, &["Protocol"]).to_ascii_lowercase(),
        port_range: jstr(item, &["Port"]),
        cidr: jstr(item, &["CidrBlock", "SourceCidrIp"]),
        source_group_id: String::new(),
        policy: jstr(item, &["Action"]).to_ascii_lowercase(),
        priority: String::new(),
        nic_type: "internet".into(),
        description: jstr(item, &["FirewallRuleDescription", "Description"]),
    }
}

pub fn map_sg_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["SecurityGroupId"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["SecurityGroupName"]), &id),
        capability: CAP_SECURITY_GROUP.into(),
        region_id: region_of(item, region),
        status: if vpc_of(item).is_empty() {
            "classic".into()
        } else {
            "vpc".into()
        },
        fields: field_map(&[
            ("vpcId", vpc_of(item)),
            ("description", jstr(item, &["SecurityGroupDesc", "Description"])),
            ("creationTime", jstr(item, &["CreatedTime", "CreationTime"])),
            ("projectId", jstr(item, &["ProjectId"])),
        ]),
    }
}

pub fn map_sg_policy(item: &Value, direction: &str) -> CloudNetworkRule {
    CloudNetworkRule {
        id: jstr(item, &["PolicyIndex"]),
        direction: direction.to_string(),
        protocol: jstr(item, &["Protocol"]).to_ascii_lowercase(),
        port_range: jstr(item, &["Port"]),
        cidr: jstr(item, &["CidrBlock", "Ipv6CidrBlock"]),
        source_group_id: jstr(item, &["SecurityGroupId"]),
        policy: jstr(item, &["Action"]).to_ascii_lowercase(),
        priority: jstr(item, &["PolicyIndex"]),
        nic_type: String::new(),
        description: jstr(item, &["PolicyDescription", "Description"]),
    }
}

pub fn sg_policies_from_set(body: &Value) -> Vec<CloudNetworkRule> {
    let set = body
        .get("SecurityGroupPolicySet")
        .cloned()
        .unwrap_or_else(|| body.clone());
    let mut rules = Vec::new();
    for item in jarr(&set, &["Ingress"]) {
        rules.push(map_sg_policy(&item, "ingress"));
    }
    for item in jarr(&set, &["Egress"]) {
        rules.push(map_sg_policy(&item, "egress"));
    }
    rules
}

pub fn sg_to_detail(item: &Value, region: &str, rules: Vec<CloudNetworkRule>) -> CloudResourceDetail {
    let mut row = map_sg_row(item, region);
    if !rules.is_empty() {
        row.fields
            .insert("ruleCount".into(), rules.len().to_string());
    }
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/vpc/security-group/detail?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.rules = rules;
    detail.extra = item.clone();
    detail
}

pub fn map_eip_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["AddressId"]);
    let ip = jstr(item, &["AddressIp"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["AddressName"]), &ip),
        capability: CAP_NETWORK_EIP.into(),
        region_id: region_of(item, region),
        status: jstr(item, &["AddressStatus", "Status"]),
        fields: field_map(&[
            ("publicIp", ip),
            ("bandwidth", jstr(item, &["Bandwidth", "InternetMaxBandwidthOut"])),
            ("instanceId", jstr(item, &["InstanceId"])),
            ("instanceType", jstr(item, &["InstanceType"])),
            ("chargeType", jstr(item, &["InternetChargeType", "ChargeType"])),
        ]),
    }
}

pub fn eip_to_detail(item: &Value, region: &str) -> CloudResourceDetail {
    let row = map_eip_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let instance_id = row.fields.get("instanceId").cloned().unwrap_or_default();
    let instance_type = row.fields.get("instanceType").cloned().unwrap_or_default();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/vpc/eip?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.metric_ids = metric_ids(EIP_METRIC_IDS);
    if !instance_id.is_empty() {
        let capability = if instance_type.to_ascii_uppercase().contains("CLB")
            || instance_type.to_ascii_uppercase().contains("LB")
        {
            CAP_LOAD_BALANCER
        } else {
            CAP_COMPUTE
        };
        detail.related.push(CloudRelatedRef {
            capability: capability.into(),
            resource_id: instance_id.clone(),
            name: instance_id,
            role: "instance".into(),
        });
    }
    detail.extra = item.clone();
    detail
}

pub fn map_lb_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["LoadBalancerId"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["LoadBalancerName"]), &id),
        capability: CAP_LOAD_BALANCER.into(),
        region_id: region_of(item, region),
        status: map_instance_status(&jstr(item, &["Status", "LoadBalancerStatus"])),
        fields: field_map(&[
            ("publicIp", jips(item, &["LoadBalancerVips", "Address"])),
            ("addressType", jstr(item, &["LoadBalancerType", "AddressIPVersion"])),
            ("instanceClass", jstr(item, &["LoadBalancerPassToTarget", "Forward"])),
            ("bandwidth", jstr(item, &["Bandwidth", "InternetMaxBandwidthOut"])),
            ("vpcId", vpc_of(item)),
        ]),
    }
}

pub fn lb_to_detail(
    item: &Value,
    region: &str,
    listeners: &[Value],
    targets: &[Value],
) -> CloudResourceDetail {
    let row = map_lb_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/clb/detail?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.metric_ids = metric_ids(LB_METRIC_IDS);
    if let Some(vpc) = related_vpc(detail.fields.get("vpcId").map(String::as_str).unwrap_or("")) {
        detail.related.push(vpc);
    }
    for listener in listeners {
        let lid = jstr(listener, &["ListenerId"]);
        detail.children.push(CloudChildRow {
            id: lid.clone(),
            kind: "listener".into(),
            name: display_name(&jstr(listener, &["ListenerName"]), &lid),
            status: jstr(listener, &["Status"]),
            fields: field_map(&[
                ("protocol", jstr(listener, &["Protocol"])),
                ("port", jstr(listener, &["Port"])),
            ]),
        });
    }
    for group in targets {
        for target in jarr(group, &["Targets", "TargetSet"]) {
            let tid = jstr(&target, &["InstanceId", "PrivateIpAddresses"]);
            detail.children.push(CloudChildRow {
                id: tid.clone(),
                kind: "backend".into(),
                name: display_name(&jstr(&target, &["InstanceName"]), &tid),
                status: jstr(&target, &["HealthStatus"]),
                fields: field_map(&[
                    ("port", jstr(&target, &["Port"])),
                    ("weight", jstr(&target, &["Weight"])),
                    ("privateIp", jips(&target, &["PrivateIpAddresses"])),
                ]),
            });
        }
    }
    detail.extra = item.clone();
    detail
}

pub fn map_cdb_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["InstanceId"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["InstanceName"]), &id),
        capability: CAP_DATABASE.into(),
        region_id: region_of(item, region),
        status: map_instance_status(&jstr(item, &["Status"])),
        fields: field_map(&[
            ("engine", nonempty_or(jstr(item, &["EngineType", "DeviceType"]), "MySQL")),
            ("engineVersion", jstr(item, &["EngineVersion"])),
            ("instanceClass", jstr(item, &["Memory", "InstanceType"])),
            ("storage", jstr(item, &["Volume", "DiskSize"])),
            ("zone", zone_of(item)),
            (
                "connectionString",
                nonempty_or(jstr(item, &["Vip", "WanDomain"]), jstr(item, &["UniqVpcId"])),
            ),
            ("port", jstr(item, &["Vport", "WanPort"])),
            ("vpcId", vpc_of(item)),
            ("chargeType", jstr(item, &["PayType", "ChargeType"])),
            ("expiredTime", jstr(item, &["DeadlineTime", "ExpiredTime"])),
        ]),
    }
}

fn nonempty_or(value: String, fallback: impl Into<String>) -> String {
    if value.trim().is_empty() {
        fallback.into()
    } else {
        value
    }
}

pub fn cdb_to_detail(item: &Value, region: &str) -> CloudResourceDetail {
    let row = map_cdb_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/cdb/instance/detail?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.metric_ids = metric_ids(RDS_METRIC_IDS);
    detail.log_kinds = vec!["slow".into()];
    if let Some(vpc) = related_vpc(detail.fields.get("vpcId").map(String::as_str).unwrap_or("")) {
        detail.related.push(vpc);
    }
    detail.extra = item.clone();
    detail
}

pub fn map_cdb_sg_rule(item: &Value) -> CloudNetworkRule {
    CloudNetworkRule {
        id: jstr(item, &["SecurityGroupId"]),
        direction: "ingress".into(),
        protocol: "all".into(),
        port_range: "ALL".into(),
        cidr: String::new(),
        source_group_id: jstr(item, &["SecurityGroupId"]),
        policy: "accept".into(),
        priority: String::new(),
        nic_type: "securityGroup".into(),
        description: jstr(item, &["SecurityGroupName"]),
    }
}

pub fn map_redis_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["InstanceId"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["InstanceName"]), &id),
        capability: CAP_DATABASE_CACHE.into(),
        region_id: region_of(item, region),
        status: map_instance_status(&jstr(item, &["Status"])),
        fields: field_map(&[
            ("engine", nonempty_or(jstr(item, &["Type", "ProductType"]), "Redis")),
            ("engineVersion", jstr(item, &["CurrentRedisVersion", "RedisVersion"])),
            ("instanceClass", jstr(item, &["Size", "RedisShardSize"])),
            ("capacity", jstr(item, &["Size"])),
            ("zone", zone_of(item)),
            ("connectionString", jstr(item, &["WanIp", "Vip"])),
            ("port", jstr(item, &["Port"])),
            ("vpcId", vpc_of(item)),
            ("chargeType", jstr(item, &["BillingMode", "PayMode"])),
            ("expiredTime", jstr(item, &["DeadlineTime", "ExpiredTime"])),
        ]),
    }
}

pub fn redis_to_detail(item: &Value, region: &str) -> CloudResourceDetail {
    let row = map_redis_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/redis/instance/manage?rid=&id={id}&regionId={region_id}"
        )),
    );
    detail.metric_ids = metric_ids(KV_METRIC_IDS);
    detail.log_kinds = vec!["slow".into()];
    if let Some(vpc) = related_vpc(detail.fields.get("vpcId").map(String::as_str).unwrap_or("")) {
        detail.related.push(vpc);
    }
    detail.extra = item.clone();
    detail
}

pub fn map_disk_row(item: &Value, region: &str) -> CloudResourceRow {
    let id = jstr(item, &["DiskId"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["DiskName"]), &id),
        capability: CAP_STORAGE_DISK.into(),
        region_id: region_of(item, region),
        status: jstr(item, &["DiskState", "Status"]),
        fields: field_map(&[
            ("size", jstr(item, &["DiskSize"])),
            ("category", jstr(item, &["DiskType"])),
            ("type", jstr(item, &["DiskUsage"])),
            ("zone", zone_of(item)),
            ("instanceId", jstr(item, &["InstanceId"])),
            ("chargeType", jstr(item, &["DiskChargeType"])),
        ]),
    }
}

pub fn map_snapshot_child(item: &Value) -> CloudChildRow {
    CloudChildRow {
        id: jstr(item, &["SnapshotId"]),
        kind: "snapshot".into(),
        name: display_name(&jstr(item, &["SnapshotName"]), &jstr(item, &["SnapshotId"])),
        status: jstr(item, &["SnapshotState", "Status"]),
        fields: field_map(&[
            ("creationTime", jstr(item, &["CreatedTime", "CreationTime"])),
            ("size", jstr(item, &["DiskSize"])),
            ("progress", jstr(item, &["Percent", "Progress"])),
            ("type", jstr(item, &["SnapshotType", "DiskUsage"])),
            ("sourceDisk", jstr(item, &["DiskId"])),
        ]),
    }
}

pub fn disk_to_detail(item: &Value, region: &str, snapshots: Vec<CloudChildRow>) -> CloudResourceDetail {
    let row = map_disk_row(item, region);
    let id = row.id.clone();
    let region_id = row.region_id.clone();
    let instance_id = row.fields.get("instanceId").cloned().unwrap_or_default();
    let mut detail = CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/cvm/cbs/detail?rid=&id={id}&regionId={region_id}"
        )),
    );
    if !instance_id.is_empty() {
        detail.related.push(CloudRelatedRef {
            capability: CAP_COMPUTE.into(),
            resource_id: instance_id.clone(),
            name: instance_id,
            role: "instance".into(),
        });
    }
    attach_snapshots(&mut detail, snapshots);
    detail.extra = item.clone();
    detail
}

pub fn attach_instance_disks(detail: &mut CloudResourceDetail, disks: &[Value]) {
    if !disks.is_empty() {
        detail
            .fields
            .insert("diskCount".into(), disks.len().to_string());
    }
    for disk in disks {
        let id = jstr(disk, &["DiskId"]);
        if id.is_empty() {
            continue;
        }
        let name = display_name(&jstr(disk, &["DiskName"]), &id);
        let size = jstr(disk, &["DiskSize"]);
        let usage = jstr(disk, &["DiskUsage"]);
        let label = [name, if size.is_empty() { String::new() } else { format!("{size}GB") }, usage]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        detail.related.push(CloudRelatedRef {
            capability: CAP_STORAGE_DISK.into(),
            resource_id: id,
            name: label,
            role: "disk".into(),
        });
    }
}

pub fn attach_snapshots(detail: &mut CloudResourceDetail, snapshots: Vec<CloudChildRow>) {
    if !snapshots.is_empty() {
        detail
            .fields
            .insert("snapshotCount".into(), snapshots.len().to_string());
    }
    detail.children.extend(snapshots);
}

pub fn map_cos_row(item: &Value) -> CloudResourceRow {
    let name = jstr(item, &["Name"]);
    let location = jstr(item, &["Location"]);
    CloudResourceRow {
        id: name.clone(),
        name,
        capability: CAP_OBJECT_STORAGE.into(),
        region_id: location.clone(),
        status: jstr(item, &["BucketType", "Location"]),
        fields: field_map(&[
            ("storageClass", jstr(item, &["BucketType"])),
            ("creationDate", jstr(item, &["CreationDate"])),
            (
                "endpoint",
                if location.is_empty() {
                    String::new()
                } else {
                    format!("cos.{location}.myqcloud.com")
                },
            ),
            ("location", location),
        ]),
    }
}

pub fn cos_to_detail(item: &Value) -> CloudResourceDetail {
    let row = map_cos_row(item);
    let name = row.id.clone();
    let region = row.region_id.clone();
    CloudResourceDetail::from_row(
        row,
        Some(format!(
            "https://console.cloud.tencent.com/cos/bucket?bucket={name}&region={region}"
        )),
    )
}

pub fn map_dnspod_row(item: &Value) -> CloudResourceRow {
    let name = jstr(item, &["Name", "Domain", "Punycode"]);
    CloudResourceRow {
        id: name.clone(),
        name: name.clone(),
        capability: CAP_DOMAINS.into(),
        region_id: String::new(),
        status: jstr(item, &["Status", "Grade"]),
        fields: field_map(&[
            ("domain", name),
            ("recordCount", jstr(item, &["RecordCount"])),
            ("dnsServers", jips(item, &["DnspodNs", "GradeLevel"])),
            ("type", jstr(item, &["Grade", "GradeTitle"])),
            ("instanceId", jstr(item, &["DomainId"])),
        ]),
    }
}

pub fn map_registered_domain_row(item: &Value) -> CloudResourceRow {
    let name = jstr(item, &["DomainName", "Domain", "Punycode"]);
    CloudResourceRow {
        id: name.clone(),
        name: name.clone(),
        capability: CAP_DOMAINS.into(),
        region_id: String::new(),
        status: jstr(item, &["BuyStatus", "Status"]),
        fields: field_map(&[
            ("domain", name),
            ("type", jstr(item, &["Tld", "DomainType"])),
            ("registrationDate", jstr(item, &["CreationDate", "CreateTime"])),
            (
                "expirationDate",
                jstr(item, &["ExpirationDate", "ExpireTime", "ExpiredDate"]),
            ),
            ("instanceId", jstr(item, &["DomainId"])),
        ]),
    }
}

pub fn merge_domain_rows(regs: &[Value], zones: &[Value]) -> Vec<CloudResourceRow> {
    let mut rows: Vec<CloudResourceRow> = regs.iter().map(map_registered_domain_row).collect();
    for zone in zones {
        let name = jstr(zone, &["Name", "Domain", "Punycode"]);
        if name.is_empty() {
            continue;
        }
        if let Some(row) = rows
            .iter_mut()
            .find(|row| row.id.eq_ignore_ascii_case(&name) || row.name.eq_ignore_ascii_case(&name))
        {
            let mapped = map_dnspod_row(zone);
            if let Some(count) = mapped.fields.get("recordCount") {
                row.fields.insert("recordCount".into(), count.clone());
            }
            if let Some(dns) = mapped.fields.get("dnsServers") {
                row.fields.insert("dnsServers".into(), dns.clone());
            }
            if row.status.trim().is_empty() {
                row.status = mapped.status;
            }
        } else {
            rows.push(map_dnspod_row(zone));
        }
    }
    rows
}

pub fn map_dns_record(item: &Value) -> CloudChildRow {
    let rr = jstr(item, &["Name", "SubDomain", "RR"]);
    CloudChildRow {
        id: jstr(item, &["RecordId"]),
        kind: "dnsRecord".into(),
        name: rr.clone(),
        status: jstr(item, &["Status"]),
        fields: field_map(&[
            ("type", jstr(item, &["Type", "RecordType"])),
            ("value", jstr(item, &["Value"])),
            ("ttl", jstr(item, &["TTL"])),
            ("rr", rr),
            ("line", jstr(item, &["Line", "RecordLine"])),
        ]),
    }
}

pub fn domain_detail(
    reg: Option<&Value>,
    zone: Option<&Value>,
    records: Vec<CloudChildRow>,
) -> Option<CloudResourceDetail> {
    let mut detail = if let Some(item) = reg {
        CloudResourceDetail::from_row(
            map_registered_domain_row(item),
            Some(format!(
                "https://console.cloud.tencent.com/domain/detail?domain={}",
                jstr(item, &["DomainName", "Domain"])
            )),
        )
    } else if let Some(item) = zone {
        CloudResourceDetail::from_row(
            map_dnspod_row(item),
            Some(format!(
                "https://console.cloud.tencent.com/cns/detail?domain={}",
                jstr(item, &["Name", "Domain"])
            )),
        )
    } else {
        return None;
    };
    if let Some(item) = zone {
        let mapped = map_dnspod_row(item);
        if let Some(count) = mapped.fields.get("recordCount") {
            detail.fields.insert("recordCount".into(), count.clone());
        }
        if let Some(dns) = mapped.fields.get("dnsServers") {
            detail.fields.insert("dnsServers".into(), dns.clone());
        }
    }
    detail.children = records;
    Some(detail)
}

pub fn map_cert_row(item: &Value) -> CloudResourceRow {
    let id = jstr(item, &["CertificateId", "Id"]);
    CloudResourceRow {
        id: id.clone(),
        name: display_name(&jstr(item, &["Alias", "Domain"]), &id),
        capability: CAP_CERTS.into(),
        region_id: String::new(),
        status: jstr(item, &["StatusName", "Status"]),
        fields: field_map(&[
            ("domain", jstr(item, &["Domain", "SubjectAltName"])),
            ("product", jstr(item, &["ProductZhName", "ProductType"])),
            ("certType", jstr(item, &["CertType", "CertificateType"])),
            ("buyDate", jstr(item, &["CertBeginTime", "InsertTime"])),
            ("endDate", jstr(item, &["CertEndTime", "ExpireTime"])),
        ]),
    }
}

pub fn cert_to_detail(item: &Value) -> CloudResourceDetail {
    CloudResourceDetail::from_row(
        map_cert_row(item),
        Some("https://console.cloud.tencent.com/ssl".into()),
    )
}

pub fn map_account_balance_fields(body: &Value) -> (String, String, String, String) {
    let fen = |keys: &[&str]| {
        let raw = jstr(body, keys);
        if raw.is_empty() {
            return String::new();
        }
        if let Ok(n) = raw.parse::<i64>() {
            format!("{:.2}", n as f64 / 100.0)
        } else {
            raw
        }
    };
    (
        "CNY".into(),
        fen(&["Balance", "RealBalance"]),
        fen(&["CashAccountBalance", "CashAmount"]),
        fen(&["CreditAmount", "CreditBalance"]),
    )
}

pub fn parse_slow_log_page(kind: &str, body: &Value, page: i64) -> CloudLogPage {
    let items = jarr(
        body,
        &[
            "Items",
            "Data",
            "InstanceSlowLogDetail",
            "SlowLogData",
            "Slowlogs",
        ],
    );
    let entries: Vec<CloudLogEntry> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let sql = jstr(item, &["SqlText", "Sql", "Command", "Query"]);
            let ts = jstr(item, &["Timestamp", "ExecuteTime", "QueryTime", "Date"]);
            CloudLogEntry {
                id: format!("{}:{index}", jstr(item, &["Database", "UserHost", "Client"])),
                ts_ms: parse_log_ts(&ts),
                severity: "slow".into(),
                summary: sql.chars().take(240).collect(),
                fields: field_map(&[
                    ("host", jstr(item, &["UserHost", "Client", "HostAddress"])),
                    ("db", jstr(item, &["Database", "Db"])),
                    (
                        "queryTimes",
                        jstr(item, &["QueryTime", "Duration", "QueryTimes"]),
                    ),
                    ("lockTimes", jstr(item, &["LockTime"])),
                    ("sql", sql),
                ]),
            }
        })
        .collect();
    let total = jstr(body, &["TotalCount", "Total", "TotalNum"])
        .parse::<i64>()
        .unwrap_or(entries.len() as i64);
    CloudLogPage {
        kind: kind.into(),
        total,
        page,
        entries,
    }
}

fn parse_log_ts(raw: &str) -> i64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if let Ok(n) = trimmed.parse::<i64>() {
        return if n > 1_000_000_000_000 { n } else { n.saturating_mul(1000) };
    }
    chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%SZ"))
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

pub fn monitor_series(id: &str, body: &Value) -> CloudMetricSeries {
    let points = parse_monitor_points(body);
    CloudMetricSeries {
        id: id.to_string(),
        label: metric_label(id),
        unit: metric_unit(id).into(),
        points,
    }
}

fn parse_monitor_points(body: &Value) -> Vec<CloudMetricPoint> {
    let mut points = Vec::new();
    for series in jarr(body, &["DataPoints", "DataPoint"]) {
        let timestamps = series
            .get("Timestamps")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let values = series
            .get("Values")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for (ts, val) in timestamps.iter().zip(values.iter()) {
            let ts_raw = ts.as_i64().or_else(|| ts.as_u64().map(|n| n as i64)).unwrap_or(0);
            let value = val
                .as_f64()
                .or_else(|| val.as_i64().map(|n| n as f64))
                .or_else(|| val.as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(0.0);
            if ts_raw <= 0 {
                continue;
            }
            let ts_ms = if ts_raw > 1_000_000_000_000 {
                ts_raw
            } else {
                ts_raw.saturating_mul(1000)
            };
            points.push(CloudMetricPoint { ts_ms, value });
        }
    }
    points.sort_by_key(|p| p.ts_ms);
    points
}

fn metric_unit(id: &str) -> &'static str {
    match id {
        "CPUUtilization" | "memory_usedutilization" => "%",
        "InternetInRate" | "InternetOutRate" => "bps",
        "DiskReadBPS" | "DiskWriteBPS" => "B/s",
        _ => "",
    }
}

fn metric_label(id: &str) -> String {
    match id {
        "CPUUtilization" => "CPU".into(),
        "memory_usedutilization" => "内存".into(),
        "InternetInRate" => "公网入".into(),
        "InternetOutRate" => "公网出".into(),
        "DiskReadBPS" => "磁盘读".into(),
        "DiskWriteBPS" => "磁盘写".into(),
        _ => id.to_string(),
    }
}

/// 前端指标 id → 腾讯云 (Namespace 由 capability 决定后的 MetricName)。
pub fn tencent_metric_name(capability: &str, id: &str) -> Option<&'static str> {
    match (capability.trim(), id) {
        (CAP_COMPUTE | CAP_COMPUTE_LITE, "CPUUtilization") => Some("CpuUsage"),
        (CAP_COMPUTE | CAP_COMPUTE_LITE, "memory_usedutilization") => Some("MemUsage"),
        (CAP_COMPUTE | CAP_COMPUTE_LITE, "InternetInRate") => Some("WanIntraffic"),
        (CAP_COMPUTE | CAP_COMPUTE_LITE, "InternetOutRate") => Some("WanOuttraffic"),
        (CAP_COMPUTE | CAP_COMPUTE_LITE, "DiskReadBPS") => Some("DiskReadTraffic"),
        (CAP_COMPUTE | CAP_COMPUTE_LITE, "DiskWriteBPS") => Some("DiskWriteTraffic"),
        (CAP_DATABASE, "CPUUtilization") => Some("CpuUseRate"),
        (CAP_DATABASE, "memory_usedutilization") => Some("MemoryUseRate"),
        (CAP_DATABASE, "DiskReadBPS") => Some("RealCapacity"),
        (CAP_DATABASE, "DiskWriteBPS") => Some("VolumeRate"),
        (CAP_DATABASE_CACHE, "CPUUtilization") => Some("CpuUsMin"),
        (CAP_DATABASE_CACHE, "memory_usedutilization") => Some("MemUtil"),
        (CAP_DATABASE_CACHE, "InternetInRate") => Some("InFlow"),
        (CAP_DATABASE_CACHE, "InternetOutRate") => Some("OutFlow"),
        (CAP_NETWORK_EIP | CAP_LOAD_BALANCER, "InternetInRate") => Some("Intraffic"),
        (CAP_NETWORK_EIP | CAP_LOAD_BALANCER, "InternetOutRate") => Some("Outtraffic"),
        _ => None,
    }
}

pub fn monitor_namespace(capability: &str) -> Option<&'static str> {
    match capability.trim() {
        CAP_COMPUTE => Some("QCE/CVM"),
        CAP_COMPUTE_LITE => Some("QCE/LIGHTHOUSE"),
        CAP_DATABASE => Some("QCE/CDB"),
        CAP_DATABASE_CACHE => Some("QCE/REDIS"),
        CAP_LOAD_BALANCER => Some("QCE/LB_PUBLIC"),
        CAP_NETWORK_EIP => Some("QCE/LB"),
        _ => None,
    }
}

pub fn monitor_dimension(capability: &str) -> &'static str {
    match capability.trim() {
        CAP_DATABASE => "InstanceId",
        CAP_DATABASE_CACHE => "instanceid",
        CAP_LOAD_BALANCER => "vip",
        CAP_NETWORK_EIP => "eip",
        _ => "InstanceId",
    }
}

pub fn default_metric_ids(capability: &str) -> &'static [&'static str] {
    match capability.trim() {
        CAP_COMPUTE | CAP_COMPUTE_LITE => COMPUTE_METRIC_IDS,
        CAP_DATABASE => RDS_METRIC_IDS,
        CAP_DATABASE_CACHE => KV_METRIC_IDS,
        CAP_NETWORK_EIP => EIP_METRIC_IDS,
        CAP_LOAD_BALANCER => LB_METRIC_IDS,
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_cvm_running_and_shutdown() {
        assert_eq!(map_instance_status("RUNNING"), "RUNNING");
        assert_eq!(map_instance_status("STOPPED"), "STOPPED");
        assert_eq!(map_instance_status("SHUTDOWN"), "STOPPED");
        let row = map_cvm_row(
            &json!({
                "InstanceId": "ins-1",
                "InstanceName": "web",
                "InstanceState": "RUNNING",
                "InstanceType": "S5.MEDIUM2",
                "Placement": { "Zone": "ap-guangzhou-3" },
                "PublicIpAddresses": ["1.1.1.1"],
                "PrivateIpAddresses": ["10.0.0.2"],
                "ExpiredTime": "2026-12-01T00:00:00Z",
                "InstanceChargeType": "PREPAID",
                "SecurityGroupIds": ["sg-a"],
                "OsName": "TencentOS",
                "VirtualPrivateCloud": { "VpcId": "vpc-1" }
            }),
            "ap-guangzhou",
        );
        assert_eq!(row.capability, CAP_COMPUTE);
        assert_eq!(row.status, "RUNNING");
        assert_eq!(row.fields.get("publicIp").map(String::as_str), Some("1.1.1.1"));
        assert_eq!(row.fields.get("instanceType").map(String::as_str), Some("S5.MEDIUM2"));
        assert_eq!(row.fields.get("zone").map(String::as_str), Some("ap-guangzhou-3"));
        assert_eq!(row.fields.get("vpcId").map(String::as_str), Some("vpc-1"));
    }

    #[test]
    fn dns_record_fields_align() {
        let child = map_dns_record(&json!({
            "RecordId": 12,
            "Name": "www",
            "Type": "A",
            "Value": "1.2.3.4",
            "TTL": 600
        }));
        assert_eq!(child.kind, "dnsRecord");
        assert_eq!(child.fields.get("rr").map(String::as_str), Some("www"));
        assert_eq!(child.fields.get("type").map(String::as_str), Some("A"));
        assert_eq!(child.fields.get("value").map(String::as_str), Some("1.2.3.4"));
        assert_eq!(child.fields.get("ttl").map(String::as_str), Some("600"));
    }
}
