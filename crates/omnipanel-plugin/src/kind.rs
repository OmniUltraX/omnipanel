use serde::{Deserialize, Serialize};
use specta::Type;

/// 插件身份。新增 kind 只接受平台级能力（多租户），不为单一产品开口子。
/// `knowledge`（知识源适配器：思源/Obsidian/Logseq/Notion 只读镜像）即此类。
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
    Knowledge,
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
            Self::Knowledge => "knowledge",
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
            "knowledge" => Ok(Self::Knowledge),
            other => Err(format!("未知插件 kind: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_roundtrip_covers_knowledge() {
        assert_eq!(PluginKind::parse("knowledge"), Ok(PluginKind::Knowledge));
        assert_eq!(PluginKind::Knowledge.as_str(), "knowledge");
        // serde 与 specta 共用小写形态。
        let json = serde_json::to_string(&PluginKind::Knowledge).unwrap();
        assert_eq!(json, "\"knowledge\"");
        assert!(PluginKind::parse("wiki").is_err());
    }
}
