//! `.omni-plugin` 包格式（阶段 B / L1 开放基石）。
//!
//! 包结构：zip 容器，必含 `plugin.json`；`signature.ed25519` 为对
//! 「除自身外全部条目按路径排序后的规范化字节流」的 ed25519 签名。
//!
//! 规范化字节流：
//! `for name in sort(names - signature): u32le(len(name)) | name | u32le(len(data)) | data`
//!
//! 安全策略：
//! - release 构建仅接受 [`OFFICIAL_VERIFY_PUBKEYS_HEX`] 内的签名；
//! - debug 构建（dev）可经 [`verify_file_dev`] 装载未签名包，仅供本地开发。

pub mod devkey;
pub mod pack;

pub use pack::{extract_to, pack_dir, pack_dir_with_entries};

use std::fs::File;
use std::io::{BufReader, Read, read_to_string};
use std::path::Path;

use ed25519_dalek::{SIGNATURE_LENGTH, Signature, VerifyingKey};
use omnipanel_plugin::PluginManifest;
use thiserror::Error;
use zip::ZipArchive;

/// 签名条目名；不参与规范化字节流。
pub const SIGNATURE_ENTRY: &str = "signature.ed25519";
pub const MANIFEST_ENTRY: &str = "plugin.json";

#[derive(Debug, Error)]
pub enum PkgError {
    #[error("无法读取包文件: {0}")]
    Io(String),
    #[error("非法 .omni-plugin 包: {0}")]
    Malformed(String),
    #[error("包缺少 {0}")]
    MissingEntry(String),
    #[error("签名校验失败")]
    BadSignature,
    #[error("未签名包被拒绝（release 构建仅接受官方签名）")]
    UnsignedRejected,
    #[error("清单非法: {0}")]
    Manifest(String),
}

impl From<zip::result::ZipError> for PkgError {
    fn from(err: zip::result::ZipError) -> Self {
        match err {
            zip::result::ZipError::FileNotFound => Self::MissingEntry("entry".into()),
            other => Self::Io(other.to_string()),
        }
    }
}

impl From<std::io::Error> for PkgError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

/// 官方验签公钥列表（hex，32 字节）。首发为开发公钥；
/// 正式发布前替换为离线保管的发布公钥，多 key 支持灰度轮换。
pub const OFFICIAL_VERIFY_PUBKEYS_HEX: &[&str] =
    &["9c7d16e456512071833af535955a2a062ea6ac65aa961ef805398a0c38df6a2c"];

fn official_verifying_keys() -> Vec<VerifyingKey> {
    OFFICIAL_VERIFY_PUBKEYS_HEX
        .iter()
        .filter_map(|hex_str| {
            let raw = hex::decode(hex_str).ok()?;
            let bytes: [u8; 32] = raw.try_into().ok()?;
            VerifyingKey::from_bytes(&bytes).ok()
        })
        .collect()
}

fn push_framed(out: &mut Vec<u8>, name: &str, data: &[u8]) {
    let name_bytes = name.as_bytes();
    out.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(name_bytes);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
}

/// 规范化字节流：排除签名条目后按路径排序拼接。
fn canonical_bytes<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Vec<u8>, PkgError> {
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|name| *name != SIGNATURE_ENTRY)
        .map(str::to_string)
        .collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let mut file = archive.by_name(&name)?;
        if file.is_dir() {
            continue;
        }
        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data)?;
        push_framed(&mut out, &name, &data);
    }
    Ok(out)
}

fn read_signature<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Option<Signature>, PkgError> {
    match archive.by_name(SIGNATURE_ENTRY) {
        Ok(mut file) => {
            let mut buf = vec![0u8; SIGNATURE_LENGTH];
            let read = file.read(&mut buf)?;
            if read != SIGNATURE_LENGTH {
                return Err(PkgError::Malformed("签名长度非法".into()));
            }
            Ok(Some(Signature::from_bytes(
                &buf.try_into().expect("64 bytes"),
            )))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn parse_manifest<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<PluginManifest, PkgError> {
    let mut file = archive
        .by_name(MANIFEST_ENTRY)
        .map_err(|_| PkgError::MissingEntry(MANIFEST_ENTRY.into()))?;
    let text = read_to_string(&mut file)?;
    PluginManifest::from_json(&text).map_err(|e| PkgError::Manifest(e.to_string()))
}

/// release 验签路径：签名必须存在且在官方公钥列表内验证通过。
pub fn verify_file(path: &Path) -> Result<PluginManifest, PkgError> {
    verify_file_with_keys(path, &official_verifying_keys())
}

/// 多公钥验签：任一通过即放行；正式 key 可经环境注入追加（`OMNIPANEL_PLUGIN_PUBKEYS` 逗号分隔 hex）。
/// 解析逻辑见 `extra_verifying_keys_from_env`，与内置官方 key 取并集。
pub fn verify_file_with_keys(
    path: &Path,
    keys: &[VerifyingKey],
) -> Result<PluginManifest, PkgError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    let signature = read_signature(&mut archive)?.ok_or(PkgError::UnsignedRejected)?;
    let message = canonical_bytes(&mut archive)?;
    for key in keys
        .iter()
        .chain(extra_verifying_keys_from_env().iter())
    {
        if key.verify_strict(&message, &signature).is_ok() {
            return parse_manifest(&mut archive);
        }
    }
    Err(PkgError::BadSignature)
}

fn extra_verifying_keys_from_env() -> Vec<VerifyingKey> {
    let raw = std::env::var("OMNIPANEL_PLUGIN_PUBKEYS").unwrap_or_default();
    raw.split([',', ';', ' ', '\n'])
        .filter_map(|hex_str| {
            let hex_str = hex_str.trim();
            if hex_str.is_empty() {
                return None;
            }
            let bytes_raw = hex::decode(hex_str).ok()?;
            let bytes: [u8; 32] = bytes_raw.try_into().ok()?;
            VerifyingKey::from_bytes(&bytes).ok()
        })
        .collect()
}

/// dev 路径（仅 `debug_assertions` 生效）：允许无签名包；
/// 有签名但与官方 key 不匹配仍拒绝（防止拿错 key 的包混入）。
pub fn verify_file_dev(path: &Path) -> Result<PluginManifest, PkgError> {
    if !cfg!(debug_assertions) {
        return verify_file(path);
    }
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    match read_signature(&mut archive)? {
        Some(signature) => {
            let message = canonical_bytes(&mut archive)?;
            for key in official_verifying_keys()
                .into_iter()
                .chain(extra_verifying_keys_from_env())
            {
                if key.verify_strict(&message, &signature).is_ok() {
                    return parse_manifest(&mut archive);
                }
            }
            Err(PkgError::BadSignature)
        }
        None => parse_manifest(&mut archive),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devkey::dev_signing_key;
    use crate::pack::{pack_dir, pack_dir_with_entries};
    use std::collections::BTreeMap;

    fn sample_entries() -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([
            (
                MANIFEST_ENTRY.to_string(),
                br#"{"id":"omni.addon.demo","version":"0.1.0","kind":"addon","permissions":[]}"#
                    .to_vec(),
            ),
            (format!("assets/{}", "icon.svg"), b"<svg/>".to_vec()),
        ])
    }

    #[test]
    fn pack_verify_roundtrip_with_dev_key() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("demo.omni-plugin");
        pack_dir_with_entries(sample_entries(), &out, Some(&dev_signing_key())).unwrap();

        let manifest = verify_file(&out).unwrap_or_else(|e| panic!("verify failed: {e}"));
        assert_eq!(manifest.id, "omni.addon.demo");
    }

    #[test]
    fn tampered_content_fails_verification() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("demo.omni-plugin");
        pack_dir_with_entries(sample_entries(), &out, Some(&dev_signing_key())).unwrap();

        // 读出全部条目，篡改一个内容字节，保留原签名重打包
        let file = File::open(&out).unwrap();
        let mut archive = ZipArchive::new(BufReader::new(file)).unwrap();
        let mut entries = BTreeMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            if f.is_dir() {
                continue;
            }
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            entries.insert(f.name().to_string(), data);
        }
        let icon = entries.get_mut("assets/icon.svg").unwrap();
        icon[0] ^= 0x01;

        let tampered = temp.path().join("tampered.omni-plugin");
        pack_dir_with_entries(entries, &tampered, None).unwrap();

        assert!(matches!(
            verify_file(&tampered),
            Err(PkgError::BadSignature)
        ));
    }

    #[test]
    fn unsigned_rejected_on_release_path_but_allowed_in_dev() {
        let temp = tempfile::tempdir().unwrap();
        let unsigned = temp.path().join("unsigned.omni-plugin");
        pack_dir_with_entries(sample_entries(), &unsigned, None).unwrap();

        assert!(matches!(
            verify_file(&unsigned),
            Err(PkgError::UnsignedRejected)
        ));
        let manifest = verify_file_dev(&unsigned).unwrap();
        assert_eq!(manifest.id, "omni.addon.demo");
    }

    #[test]
    fn wrong_key_signature_rejected_everywhere() {
        let temp = tempfile::tempdir().unwrap();
        let other = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let out = temp.path().join("wrong-key.omni-plugin");
        pack_dir_with_entries(sample_entries(), &out, Some(&other)).unwrap();

        assert!(matches!(verify_file(&out), Err(PkgError::BadSignature)));
        // dev 路径同样拒绝错误签名的包（只放行「完全未签名」）
        assert!(matches!(verify_file_dev(&out), Err(PkgError::BadSignature)));
    }

    #[test]
    fn missing_manifest_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("empty.omni-plugin");
        let entries = BTreeMap::from([("other.txt".to_string(), b"x".to_vec())]);
        let err = pack_dir_with_entries(entries, &out, Some(&dev_signing_key())).unwrap_err();
        assert!(matches!(err, PkgError::MissingEntry(_)));
    }

    #[test]
    fn manifest_entry_must_parse() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("bad.omni-plugin");
        let entries = BTreeMap::from([(MANIFEST_ENTRY.to_string(), br#"{"id":"x"}"#.to_vec())]);
        pack_dir_with_entries(entries, &out, Some(&dev_signing_key())).unwrap();
        assert!(matches!(
            verify_file(&out),
            Err(PkgError::Manifest(_) | PkgError::BadSignature)
        ));
    }
}
