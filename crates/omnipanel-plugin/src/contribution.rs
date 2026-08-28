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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UiContributes {
    #[serde(default)]
    pub sidebar: bool,
    /// `kind: module` 的 AppModule key；空则不补种侧栏模块。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub module_key: String,
    #[serde(default)]
    pub connection_form: Option<Value>,
    #[serde(default)]
    pub panel_tabs: Vec<Value>,
    #[serde(default)]
    pub commands: Vec<Value>,
    /// Database Host L2 工作台插槽（tree / editor / preview）。
    #[serde(default)]
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
