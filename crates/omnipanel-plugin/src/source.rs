use serde::{Deserialize, Serialize};
use specta::Type;

/// 插件来源：编译期内置（不可卸载）vs 磁盘安装（可卸载/升级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginSource {
    Builtin,
    Installed,
}

impl PluginSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Installed => "installed",
        }
    }
}
