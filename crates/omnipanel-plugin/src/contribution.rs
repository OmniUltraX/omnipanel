use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// 插件向 Host 声明的贡献点（公共插槽，kind 不独占）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributes {
    #[serde(default)]
    pub ui: UiContributes,
    #[serde(default)]
    pub menus: Vec<Value>,
    #[serde(default)]
    pub overlays: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher: Option<LauncherContribution>,
    #[serde(default)]
    pub discovery: Vec<DiscoveryContribution>,
    #[serde(default)]
    pub importers: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub themes: Option<ThemeContribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiContributes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudContributes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<ModuleContributes>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudContributes {
    #[serde(default)]
    pub capabilities: Vec<CloudCapabilityDecl>,
    /// 连接对话框地区预置；空则由宿主第一方列表或用户自填。
    #[serde(default)]
    pub regions: Vec<CloudRegionDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudRegionDecl {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleContributes {
    #[serde(default)]
    pub capabilities: Vec<ModuleCapabilityDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<ModuleProbeDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCapabilityDecl {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub columns: Vec<Value>,
    #[serde(default)]
    pub actions: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub get_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_fields: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_columns: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_item_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_list_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleProbeDecl {
    #[serde(default)]
    pub ports: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudCapabilityDecl {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub columns: Vec<Value>,
    #[serde(default)]
    pub actions: Vec<Value>,
    /// 详情插槽：`overview` / `metrics` / `rules` / `logs` / `security` / `records` / `members` / `backups`。
    #[serde(default)]
    pub detail_slots: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UiContributes {
    #[serde(default)]
    pub sidebar: bool,
    /// `kind: module` 的 AppModule key；空则不补种侧栏模块。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub module_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_form: Option<Value>,
    #[serde(default)]
    pub panel_tabs: Vec<Value>,
    #[serde(default)]
    pub commands: Vec<Value>,
    /// Database Host L2 工作台插槽（tree / editor / preview）。
    /// 缺省必须省略（None → 跳过），否则 reserialize 出显式 null 会把前端 zod 卡死。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workbench: Option<Value>,
    /// 首页启动条资格：声明后由用户决定钉不钉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<HomeContribution>,
}

fn default_home_show() -> bool {
    true
}

/// 首页启动条调起：对齐现有 overlay / 导入向导 / 模块路由。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HomeOpenContribution {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HomeContribution {
    #[serde(default = "default_home_show")]
    pub show: bool,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub icon: String,
    pub open: HomeOpenContribution,
}

impl HomeContribution {
    pub fn validate(&self) -> Result<(), crate::error::PluginError> {
        use crate::error::PluginError;
        if self.title.trim().is_empty() {
            return Err(PluginError::InvalidManifest(
                "contributes.ui.home.title 不能为空".into(),
            ));
        }
        match self.open.kind.as_str() {
            "overlay" | "importer" | "module" => {}
            other => {
                return Err(PluginError::InvalidManifest(format!(
                    "contributes.ui.home.open.kind 非法: {other}"
                )));
            }
        }
        if self.open.id.trim().is_empty() {
            return Err(PluginError::InvalidManifest(
                "contributes.ui.home.open.id 不能为空".into(),
            ));
        }
        if !self.icon.is_empty() {
            let icon = self.icon.trim();
            let relative_ok = !icon.is_empty()
                && !icon.starts_with('/')
                && !icon.starts_with('\\')
                && !icon.contains("://")
                && !icon.split(['/', '\\']).any(|seg| seg == "..");
            let ext_ok = {
                let lower = icon.to_ascii_lowercase();
                lower.ends_with(".svg") || lower.ends_with(".png")
            };
            if !relative_ok || !ext_ok {
                return Err(PluginError::InvalidManifest(format!(
                    "contributes.ui.home.icon 仅允许包内相对路径的 svg/png: {icon}"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LauncherContribution {
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryContribution {
    pub probe_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    #[serde(default)]
    pub tokens: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContributes {
    #[serde(default)]
    pub tools: Vec<AiToolContribution>,
}

/// 插件 AI 工具声明。`external_exposed` 默认 false。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiToolContribution {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub exec_kind: AiToolExecKind,
    #[serde(default)]
    pub module_key: String,
    #[serde(default)]
    pub cross_module: bool,
    #[serde(default)]
    pub external_exposed: bool,
    #[serde(default = "default_input_schema")]
    pub input_schema: Value,
}

fn default_input_schema() -> Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiToolExecKind {
    #[default]
    Native,
    UiDelegated,
}
