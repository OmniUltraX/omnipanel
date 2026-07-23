use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 多文件快照 schema（overview + 分模块列表）。
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 2;

/// 固定模块 id 顺序（与 Collector / overview 字段一致）。
pub const MODULE_IDS: &[&str] = &[
    "terminal",
    "database",
    "docker",
    "files",
    "server",
    "knowledge",
    "protocol",
    "tasks",
];

/// 采集后的各模块 section（内存态，上传前再拆文件）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSnapshotModules {
    pub terminal: ModuleSection,
    pub database: ModuleSection,
    pub docker: ModuleSection,
    pub files: ModuleSection,
    pub server: ModuleSection,
    pub knowledge: ModuleSection,
    pub protocol: ModuleSection,
    pub tasks: ModuleSection,
}

impl AssistantSnapshotModules {
    pub fn section(&self, module_id: &str) -> Option<&ModuleSection> {
        match module_id {
            "terminal" => Some(&self.terminal),
            "database" => Some(&self.database),
            "docker" => Some(&self.docker),
            "files" => Some(&self.files),
            "server" => Some(&self.server),
            "knowledge" => Some(&self.knowledge),
            "protocol" => Some(&self.protocol),
            "tasks" => Some(&self.tasks),
            _ => None,
        }
    }

    pub fn iter_sections(&self) -> impl Iterator<Item = (&'static str, &ModuleSection)> {
        MODULE_IDS
            .iter()
            .filter_map(|id| self.section(id).map(|s| (*id, s)))
    }
}

/// 单模块载荷：正常为 items；采集失败时带 error。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSection {
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for ModuleSection {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            error: None,
        }
    }
}

impl ModuleSection {
    pub fn from_items(items: Vec<Value>) -> Self {
        Self { items, error: None }
    }

    pub fn from_error(message: impl Into<String>) -> Self {
        Self {
            items: Vec::new(),
            error: Some(message.into()),
        }
    }

    pub fn item_count(&self) -> usize {
        self.items.len()
    }
}

/// 概览文件 `overview.json`：各模块实例数量 + 模块文件 objectKey。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOverview {
    pub schema_version: u32,
    pub generated_at: String,
    pub client_device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_id: Option<String>,
    pub modules: SnapshotOverviewModules,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOverviewModules {
    pub terminal: OverviewModuleEntry,
    pub database: OverviewModuleEntry,
    pub docker: OverviewModuleEntry,
    pub files: OverviewModuleEntry,
    pub server: OverviewModuleEntry,
    pub knowledge: OverviewModuleEntry,
    pub protocol: OverviewModuleEntry,
    pub tasks: OverviewModuleEntry,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewModuleEntry {
    /// 该模块实例条数
    pub count: u32,
    /// 对应模块列表文件的 object key
    pub object_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 单模块列表文件 `modules/{id}.json`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotModuleFile {
    pub schema_version: u32,
    pub module_id: String,
    pub generated_at: String,
    pub client_device_id: String,
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 待上传的一个 JSON 对象。
#[derive(Debug, Clone)]
pub struct SnapshotUploadObject {
    pub object_key: String,
    pub body: Vec<u8>,
}

/// 一次推送组装出的多文件包（先模块文件，最后 overview）。
#[derive(Debug, Clone)]
pub struct SnapshotBundle {
    pub generated_at: String,
    /// 概览文件 object key（对外主入口）
    pub overview_key: String,
    pub files: Vec<SnapshotUploadObject>,
}

impl SnapshotBundle {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.body.len() as u64).sum()
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }
}

/// 由采集结果组装多文件快照（不上传）。
pub fn build_snapshot_bundle(
    client_device_id: &str,
    bind_id: Option<String>,
    generated_at: &str,
    snapshot_dir: &str,
    modules: &AssistantSnapshotModules,
) -> Result<SnapshotBundle, String> {
    let dir = snapshot_dir.trim_matches('/');
    let overview_key = format!("{dir}/overview.json");

    let mut files = Vec::with_capacity(MODULE_IDS.len() + 1);
    let mut overview_modules = SnapshotOverviewModules::default();

    for module_id in MODULE_IDS {
        let section = modules.section(module_id).cloned().unwrap_or_default();
        let module_key = format!("{dir}/modules/{module_id}.json");
        let module_file = SnapshotModuleFile {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            module_id: (*module_id).to_string(),
            generated_at: generated_at.to_string(),
            client_device_id: client_device_id.to_string(),
            items: section.items.clone(),
            error: section.error.clone(),
        };
        let body = serde_json::to_vec_pretty(&module_file)
            .map_err(|e| format!("序列化模块 {module_id} 失败: {e}"))?;
        files.push(SnapshotUploadObject {
            object_key: module_key.clone(),
            body,
        });

        let entry = OverviewModuleEntry {
            count: section.item_count() as u32,
            object_key: module_key,
            error: section.error,
        };
        match *module_id {
            "terminal" => overview_modules.terminal = entry,
            "database" => overview_modules.database = entry,
            "docker" => overview_modules.docker = entry,
            "files" => overview_modules.files = entry,
            "server" => overview_modules.server = entry,
            "knowledge" => overview_modules.knowledge = entry,
            "protocol" => overview_modules.protocol = entry,
            "tasks" => overview_modules.tasks = entry,
            _ => {}
        }
    }

    let overview = SnapshotOverview {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        generated_at: generated_at.to_string(),
        client_device_id: client_device_id.to_string(),
        bind_id,
        modules: overview_modules,
    };
    let overview_body =
        serde_json::to_vec_pretty(&overview).map_err(|e| format!("序列化概览失败: {e}"))?;
    // overview 放最后：模块文件先落盘，概览作为对外入口
    files.push(SnapshotUploadObject {
        object_key: overview_key.clone(),
        body: overview_body,
    });

    Ok(SnapshotBundle {
        generated_at: generated_at.to_string(),
        overview_key,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bundle_has_overview_and_eight_modules() {
        let mut modules = AssistantSnapshotModules::default();
        modules.database = ModuleSection::from_items(vec![json!({"id":"db1"})]);
        modules.tasks = ModuleSection::from_items(vec![json!({"id":"t1"}), json!({"id":"t2"})]);

        let bundle = build_snapshot_bundle(
            "dev-1",
            None,
            "2026-07-23T00:00:00Z",
            "assistant/u/dev-1/snapshots/2026-07-23T00-00-00Z-abc",
            &modules,
        )
        .unwrap();

        assert_eq!(bundle.file_count(), 9);
        assert!(bundle.overview_key.ends_with("/overview.json"));
        assert_eq!(bundle.files.last().unwrap().object_key, bundle.overview_key);

        let overview: SnapshotOverview =
            serde_json::from_slice(&bundle.files.last().unwrap().body).unwrap();
        assert_eq!(overview.schema_version, 2);
        assert_eq!(overview.modules.database.count, 1);
        assert_eq!(overview.modules.tasks.count, 2);
        assert!(overview
            .modules
            .database
            .object_key
            .ends_with("/modules/database.json"));
    }
}
