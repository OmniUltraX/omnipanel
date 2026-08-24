//! 开发签名种子：仅供本 crate 测试与 dev 打包 CLI 使用。
//!
//! 正式发布流程 MUST 使用离线保管的发布密钥，并替换
//! [`crate::OFFICIAL_VERIFY_PUBKEYS_HEX`] 为对应公钥；届时删除本模块。

use ed25519_dalek::SigningKey;

/// 固定开发种子（ASCII: "OmniPanel dev signing seed v1!!!"）。
pub const DEV_SIGNING_SEED: [u8; 32] = [
    0x4f, 0x6d, 0x6e, 0x69, 0x50, 0x61, 0x6e, 0x65, 0x6c, 0x20, 0x64, 0x65, 0x76, 0x20, 0x73,
    0x69, 0x67, 0x6e, 0x69, 0x6e, 0x67, 0x20, 0x73, 0x65, 0x65, 0x64, 0x20, 0x76, 0x31, 0x21,
    0x21, 0x21,
];

pub fn dev_signing_key() -> SigningKey {
    SigningKey::from_bytes(&DEV_SIGNING_SEED)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方公钥列表必须包含开发公钥（防止种子与列表漂移）。
    #[test]
    fn official_list_contains_dev_pubkey() {
        let pubkey_hex = hex::encode(dev_signing_key().verifying_key().as_bytes());
        assert!(crate::OFFICIAL_VERIFY_PUBKEYS_HEX.contains(&pubkey_hex.as_str()));
    }
}
