use omnipanel_error::OmniError;

use crate::driver::AliyunCloudDriver;
use crate::types::PLUGIN_ID_ALIYUN;

/// 连接 config 上的 `pluginId` / 旧 `provider` → 规范插件 id。
/// 未知 id **不**回落阿里云。
pub fn resolve_plugin_id(raw: &str) -> Result<String, OmniError> {
    let value = raw.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("aliyun") {
        return Ok(PLUGIN_ID_ALIYUN.to_string());
    }
    if value.eq_ignore_ascii_case(PLUGIN_ID_ALIYUN) {
        return Ok(PLUGIN_ID_ALIYUN.to_string());
    }
    Err(OmniError::invalid_input(format!("未知云厂商插件: {raw}")))
}

pub fn driver_for(plugin_id: &str) -> Result<AliyunCloudDriver, OmniError> {
    let id = resolve_plugin_id(plugin_id)?;
    if id == PLUGIN_ID_ALIYUN {
        return Ok(AliyunCloudDriver);
    }
    Err(OmniError::invalid_input(format!("无云厂商 Driver: {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_legacy_aliyun_resolve() {
        assert_eq!(resolve_plugin_id("").unwrap(), PLUGIN_ID_ALIYUN);
        assert_eq!(resolve_plugin_id("aliyun").unwrap(), PLUGIN_ID_ALIYUN);
        assert_eq!(resolve_plugin_id("omni.cloud.aliyun").unwrap(), PLUGIN_ID_ALIYUN);
        assert!(driver_for("aliyun").is_ok());
    }

    #[test]
    fn unknown_plugin_does_not_fallback() {
        let err = resolve_plugin_id("tencent").unwrap_err();
        assert!(err.message.contains("未知云厂商插件"));
        let err = driver_for("omni.cloud.aws").unwrap_err();
        assert!(err.message.contains("未知") || err.message.contains("无云厂商"));
    }
}
