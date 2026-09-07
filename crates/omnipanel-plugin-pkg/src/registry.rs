//! marketplace registry v2 解析与验签（静态文件协议）。
//!
//! - v2: `{ schemaVersion: 2, plugins: [{ id, kind?, name?, description?,
//!   versions: [{ version, changelog?, minHostApi?, artifact? }] }], signature? }`
//! - v1 兼容读：`{ plugins: [{ id, kind, ..., version, distribution, artifact?, ... }] }`
//!   视为单 version 条目（`distribution: "bundled"` 无 artifact 即无可下载版本）。
//! - 签名：对**剔除 `signature` 字段后的规范 JSON**（本实现序列化，字段顺序确定）
//!   做 ed25519 签名，hex 存 `signature`；验签 key 由调用方传入
//!   （官方 key / 源 pin key），与包签名同算法同 key 体系。

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use super::{PkgError, hex_to_verifying_key};

/// registry 制品（某一版本的可下载包）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryArtifact {
    pub url: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// registry 中某一插件的某一版本。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryVersion {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_api: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<RegistryArtifact>,
}

/// registry 中某一插件（多版本）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryPlugin {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub versions: Vec<RegistryVersion>,
}

/// registry 文件（v1/v2 统一内存形态；`signature` 为 hex ed25519）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub plugins: Vec<RegistryPlugin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFileV1 {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    plugins: Vec<RegistryPluginV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryPluginV1 {
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    version: String,
    #[serde(default)]
    distribution: String,
    #[serde(default)]
    artifact: Option<RegistryArtifact>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    downloads: Option<u64>,
}

/// 解析 registry 文本（v2 优先，v1 兼容），并校验版本号全部合法 semver。
pub fn parse_registry(text: &str) -> Result<RegistryFile, PkgError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| PkgError::Registry(format!("JSON 非法: {e}")))?;
    let has_versions = value
        .get("plugins")
        .and_then(|p| p.as_array())
        .map(|arr| arr.iter().any(|item| item.get("versions").is_some()))
        .unwrap_or(false);
    let schema_version = value.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut file = if schema_version >= 2 || has_versions {
        serde_json::from_value::<RegistryFile>(value)
            .map_err(|e| PkgError::Registry(format!("v2 解析失败: {e}")))?
    } else {
        let v1: RegistryFileV1 = serde_json::from_value(value)
            .map_err(|e| PkgError::Registry(format!("v1 解析失败: {e}")))?;
        from_v1(v1)
    };
    if file.schema_version == 0 {
        file.schema_version = if has_versions { 2 } else { 1 };
    }
    for plugin in &file.plugins {
        if plugin.id.trim().is_empty() {
            return Err(PkgError::Registry("插件 id 不能为空".into()));
        }
        for ver in &plugin.versions {
            semver::Version::parse(ver.version.trim()).map_err(|e| {
                PkgError::Registry(format!("{} 版本号非法 {}: {e}", plugin.id, ver.version))
            })?;
        }
    }
    Ok(file)
}

fn from_v1(v1: RegistryFileV1) -> RegistryFile {
    RegistryFile {
        schema_version: 1,
        plugins: v1
            .plugins
            .into_iter()
            .map(|p| RegistryPlugin {
                versions: vec![RegistryVersion {
                    version: p.version,
                    changelog: None,
                    min_host_api: None,
                    // bundled（无 artifact）即无可下载版本：保留空 artifact 占位，
                    // 调用方按 url 是否为空判断可下载性（与 official_catalog 一致）。
                    artifact: p.artifact,
                }],
                id: p.id,
                kind: p.kind,
                name: p.name,
                description: p.description,
            })
            .collect(),
        signature: None,
    }
}

/// 规范字节：剔除 signature 后的确定性 JSON（发布与验签同源）。
pub fn canonical_registry_bytes(file: &RegistryFile) -> Result<Vec<u8>, PkgError> {
    let mut unsigned = file.clone();
    unsigned.signature = None;
    serde_json::to_vec(&unsigned).map_err(|e| PkgError::Registry(format!("序列化失败: {e}")))
}

/// 用私钥签名 registry（发布侧）。
pub fn sign_registry(file: &RegistryFile, key: &SigningKey) -> Signature {
    let bytes = canonical_registry_bytes(file).unwrap_or_default();
    key.sign(&bytes)
}

/// 验签 registry（任一 key 通过即放行；无 signature 视为未签名）。
pub fn verify_registry(
    file: &RegistryFile,
    keys: &[VerifyingKey],
) -> Result<(), PkgError> {
    let sig_hex = file.signature.as_deref().map(str::trim).unwrap_or_default();
    if sig_hex.is_empty() {
        return Err(PkgError::UnsignedRejected);
    }
    let sig_bytes = hex::decode(sig_hex).map_err(|_| PkgError::BadSignature)?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| PkgError::BadSignature)?;
    let signature = Signature::from_bytes(&sig_arr);
    let message = canonical_registry_bytes(file)?;
    for key in keys {
        if key.verify_strict(&message, &signature).is_ok() {
            return Ok(());
        }
    }
    Err(PkgError::BadSignature)
}

/// hex 公钥 → VerifyingKey（源 pin key 解析复用）。
pub fn registry_key_from_hex(hex_str: &str) -> Option<VerifyingKey> {
    hex_to_verifying_key(hex_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devkey::dev_signing_key;

    fn sample_v2() -> RegistryFile {
        RegistryFile {
            schema_version: 2,
            plugins: vec![RegistryPlugin {
                id: "omni.sample.demo".into(),
                kind: "addon".into(),
                name: "Demo".into(),
                description: "demo".into(),
                versions: vec![
                    RegistryVersion {
                        version: "1.0.0".into(),
                        changelog: None,
                        min_host_api: None,
                        artifact: None,
                    },
                    RegistryVersion {
                        version: "1.1.0".into(),
                        changelog: Some("fix".into()),
                        min_host_api: Some(1),
                        artifact: Some(RegistryArtifact {
                            url: "https://example.com/demo.omni-plugin".into(),
                            sha256: String::new(),
                            size: 10,
                        }),
                    },
                ],
            }],
            signature: None,
        }
    }

    #[test]
    fn v2_sign_verify_roundtrip() {
        let key = dev_signing_key();
        let mut file = sample_v2();
        let sig = sign_registry(&file, &key);
        file.signature = Some(hex::encode(sig.to_bytes()));
        let text = serde_json::to_string(&file).unwrap();
        let parsed = parse_registry(&text).unwrap();
        assert_eq!(parsed.plugins.len(), 1);
        verify_registry(&parsed, &[key.verifying_key()]).unwrap();
    }

    #[test]
    fn tampered_registry_fails_verification() {
        let key = dev_signing_key();
        let mut file = sample_v2();
        let sig = sign_registry(&file, &key);
        file.signature = Some(hex::encode(sig.to_bytes()));
        let mut text = serde_json::to_string(&file).unwrap();
        text = text.replacen("1.1.0", "9.9.9", 1);
        let parsed = parse_registry(&text).unwrap();
        assert!(verify_registry(&parsed, &[key.verifying_key()]).is_err());
    }

    #[test]
    fn v1_compat_single_version() {
        let text = r#"{"schemaVersion":1,"plugins":[{"id":"omni.addon.demo","kind":"addon","version":"0.1.0","distribution":"bundled"}]}"#;
        let file = parse_registry(text).unwrap();
        assert_eq!(file.plugins.len(), 1);
        assert_eq!(file.plugins[0].versions.len(), 1);
        assert_eq!(file.plugins[0].versions[0].version, "0.1.0");
    }

    #[test]
    fn bad_version_rejected() {
        let text = r#"{"schemaVersion":2,"plugins":[{"id":"a.b","versions":[{"version":"latest"}]}]}"#;
        assert!(parse_registry(text).is_err());
    }

    #[test]
    fn unsigned_rejected() {
        let file = sample_v2();
        assert!(matches!(
            verify_registry(&file, &[]),
            Err(PkgError::UnsignedRejected)
        ));
    }
}
