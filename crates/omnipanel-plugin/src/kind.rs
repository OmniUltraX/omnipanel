use serde::{Deserialize, Serialize};
use specta::Type;

/// 插件身份。七种锁死，不为单一产品新增第八种。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Engine,
    Panel,
    Importer,
    Cloud,
    Module,
    Theme,
    Addon,
}

impl PluginKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Engine => "engine",
            Self::Panel => "panel",
            Self::Importer => "importer",
            Self::Cloud => "cloud",
            Self::Module => "module",
            Self::Theme => "theme",
            Self::Addon => "addon",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "engine" => Ok(Self::Engine),
            "panel" => Ok(Self::Panel),
            "importer" => Ok(Self::Importer),
            "cloud" => Ok(Self::Cloud),
            "module" => Ok(Self::Module),
            "theme" => Ok(Self::Theme),
            "addon" => Ok(Self::Addon),
            other => Err(format!("未知插件 kind: {other}")),
        }
    }
}
