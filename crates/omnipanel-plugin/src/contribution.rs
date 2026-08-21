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
    #[serde(default)]
    pub launcher: Option<LauncherContribution>,
    #[serde(default)]
    pub discovery: Vec<DiscoveryContribution>,
    #[serde(default)]
    pub importers: Vec<Value>,
    #[serde(default)]
    pub themes: Option<ThemeContribution>,
    #[serde(default)]
    pub ai: Option<AiContributes>,
    #[serde(default)]
    pub workspace: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UiContributes {
    #[serde(default)]
    pub sidebar: bool,
    /// `kind: module` 的 AppModule key；空则不补种侧栏模块。
    #[serde(default)]
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
