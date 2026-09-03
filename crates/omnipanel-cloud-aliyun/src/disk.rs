//! ECS 云盘与快照。

use std::collections::BTreeMap;

use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::{CloudAction, CloudChildRow};

#[derive(Debug, Clone, Default)]
pub struct CloudDisk {
    pub disk_id: String,
    pub name: String,
    pub status: String,
    pub region_id: String,
    pub zone: String,
    pub size: String,
    pub category: String,
    pub disk_type: String,
    pub instance_id: String,
    pub charge_type: String,
    pub snapshots: Vec<CloudChildRow>,
}

fn ecs_endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://ecs.{region}.aliyuncs.com/"))
}

fn parse_disk(item: &Value, region: &str) -> CloudDisk {
    CloudDisk {
        disk_id: str_field(item, &["DiskId"]),
        name: str_field(item, &["DiskName", "DiskId"]),
        status: str_field(item, &["Status"]),
        region_id: {
            let id = str_field(item, &["RegionId"]);
            if id.is_empty() {
                region.to_string()
            } else {
                id
            }
        },
        zone: str_field(item, &["ZoneId"]),
        size: str_field(item, &["Size"]),
        category: str_field(item, &["Category"]),
        disk_type: str_field(item, &["Type"]),
        instance_id: str_field(item, &["InstanceId"]),
        charge_type: str_field(item, &["DiskChargeType"]),
        snapshots: Vec::new(),
    }
}

fn snapshot_row(item: &Value) -> CloudChildRow {
    CloudChildRow {
        id: str_field(item, &["SnapshotId"]),
        kind: "snapshot".into(),
        name: str_field(item, &["SnapshotName", "SnapshotId"]),
        status: str_field(item, &["Status"]),
        fields: [
            ("creationTime", str_field(item, &["CreationTime"])),
            ("size", str_field(item, &["SourceDiskSize", "Size"])),
            ("progress", str_field(item, &["Progress"])),
            ("type", str_field(item, &["SnapshotType", "SourceDiskType"])),
            ("sourceDisk", str_field(item, &["SourceDiskId", "DiskId"])),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.to_string(), v))
        .collect(),
    }
}

impl AliyunCredentials {
    pub async fn list_disks(&self, http: &Client) -> Result<Vec<CloudDisk>, OmniError> {
        self.list_disks_filtered(http, None).await
    }

    pub async fn list_instance_disks(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudDisk>, OmniError> {
        self.list_disks_filtered(http, Some(instance_id)).await
    }

    async fn list_disks_filtered(
        &self,
        http: &Client,
        instance_id: Option<&str>,
    ) -> Result<Vec<CloudDisk>, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            if let Some(id) = instance_id {
                params.insert("InstanceId".into(), id.trim().to_string());
            }
            let body = self
                .rpc_call(http, &endpoint, "2014-05-26", "DescribeDisks", params)
                .await?;
            let items = json_list(&body, "Disks", "Disk");
            let count = items.len();
            out.extend(items.iter().map(|item| parse_disk(item, region)));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_disk(&self, http: &Client, disk_id: &str) -> Result<CloudDisk, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let id = disk_id.trim();
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("DiskIds.1".into(), id.to_string());
        let body = self
            .rpc_call(http, &endpoint, "2014-05-26", "DescribeDisks", params)
            .await?;
        json_list(&body, "Disks", "Disk")
            .first()
            .map(|item| parse_disk(item, region))
            .ok_or_else(|| OmniError::not_found(format!("未找到云盘: {id}")))
    }

    pub async fn list_disk_snapshots(
        &self,
        http: &Client,
        disk_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("DiskId".into(), disk_id.trim().to_string());
        params.insert("PageSize".into(), "50".into());
        let body = self
            .rpc_call(http, &endpoint, "2014-05-26", "DescribeSnapshots", params)
            .await?;
        Ok(json_list(&body, "Snapshots", "Snapshot")
            .iter()
            .map(snapshot_row)
            .collect())
    }

    pub async fn list_instance_snapshots(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("InstanceId".into(), instance_id.trim().to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            let body = self
                .rpc_call(http, &endpoint, "2014-05-26", "DescribeSnapshots", params)
                .await?;
            let items = json_list(&body, "Snapshots", "Snapshot");
            let count = items.len();
            out.extend(items.iter().map(snapshot_row));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 10 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn list_swas_disks(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudDisk>, OmniError> {
        let region = self.region.trim();
        let endpoint = format!("https://swas.{region}.aliyuncs.com/");
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(http, &endpoint, "2020-06-01", "ListDisks", params)
            .await?;
        Ok(json_list(&body, "Disks", "Disk")
            .iter()
            .map(|item| {
                let mut disk = parse_disk(item, region);
                if disk.instance_id.is_empty() {
                    disk.instance_id = instance_id.trim().to_string();
                }
                if disk.disk_id.is_empty() {
                    disk.disk_id = str_field(item, &["DiskId"]);
                }
                if disk.size.is_empty() {
                    disk.size = str_field(item, &["Size"]);
                }
                if disk.category.is_empty() {
                    disk.category = str_field(item, &["DiskCategory", "Category"]);
                }
                if disk.disk_type.is_empty() {
                    disk.disk_type = str_field(item, &["DiskType", "Type"]);
                }
                disk
            })
            .filter(|disk| !disk.disk_id.is_empty())
            .collect())
    }

    pub async fn list_swas_snapshots(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = format!("https://swas.{region}.aliyuncs.com/");
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        params.insert("PageSize".into(), "50".into());
        let body = self
            .rpc_call(http, &endpoint, "2020-06-01", "ListSnapshots", params)
            .await?;
        Ok(json_list(&body, "Snapshots", "Snapshot")
            .iter()
            .map(snapshot_row)
            .collect())
    }

    pub async fn attach_disk(&self, http: &Client, action: &CloudAction) -> Result<(), OmniError> {
        let instance_id = action.param("instanceId");
        if instance_id.is_empty() {
            return Err(OmniError::invalid_input("缺少实例 id"));
        }
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("DiskId".into(), action.resource_id.trim().to_string());
        params.insert("InstanceId".into(), instance_id);
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", "AttachDisk", params)
            .await?;
        Ok(())
    }

    pub async fn detach_disk(&self, http: &Client, action: &CloudAction) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("DiskId".into(), action.resource_id.trim().to_string());
        if let Some(id) = {
            let v = action.param("instanceId");
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } {
            params.insert("InstanceId".into(), id);
        }
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", "DetachDisk", params)
            .await?;
        Ok(())
    }

    pub async fn create_disk_snapshot(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = ecs_endpoint(region)?;
        let disk_id = {
            let from_param = action.param("diskId");
            if from_param.is_empty() {
                action.resource_id.trim().to_string()
            } else {
                from_param
            }
        };
        if disk_id.is_empty() {
            return Err(OmniError::invalid_input("缺少云盘 id"));
        }
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("DiskId".into(), disk_id);
        if let Some(name) = {
            let v = action.param("name");
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } {
            params.insert("SnapshotName".into(), name);
        }
        let _ = self
            .rpc_call(http, &endpoint, "2014-05-26", "CreateSnapshot", params)
            .await?;
        Ok(())
    }

    pub async fn create_swas_snapshot(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let instance_id = {
            let from_param = action.param("instanceId");
            if from_param.is_empty() {
                action.resource_id.trim().to_string()
            } else {
                from_param
            }
        };
        let disk_id = action.param("diskId");
        if instance_id.is_empty() || disk_id.is_empty() {
            return Err(OmniError::invalid_input("缺少实例或云盘 id"));
        }
        let endpoint = format!("https://swas.{region}.aliyuncs.com/");
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("InstanceId".into(), instance_id);
        params.insert("DiskId".into(), disk_id);
        if let Some(name) = {
            let v = action.param("name");
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } {
            params.insert("SnapshotName".into(), name);
        }
        let _ = self
            .rpc_call(http, &endpoint, "2020-06-01", "CreateSnapshot", params)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_snapshot_row() {
        let item = json!({
            "SnapshotId": "s-1",
            "SnapshotName": "nightly",
            "Status": "accomplished",
            "CreationTime": "2026-01-01T00:00:00Z",
            "SourceDiskSize": "40",
            "Progress": "100%",
            "SnapshotType": "timer",
            "SourceDiskId": "d-1"
        });
        let row = snapshot_row(&item);
        assert_eq!(row.id, "s-1");
        assert_eq!(row.kind, "snapshot");
        assert_eq!(row.status, "accomplished");
        assert_eq!(row.fields.get("type").map(String::as_str), Some("timer"));
        assert_eq!(row.fields.get("sourceDisk").map(String::as_str), Some("d-1"));
    }
}
