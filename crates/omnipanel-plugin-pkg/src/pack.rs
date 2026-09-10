//! `.omni-plugin` 打包：从条目集合/源目录构建 zip 并（可选）附官方签名。
//!
//! 签名在写包前基于源数据计算（规范化字节流与验签侧一致），
//! 因此无需两段式重写 zip。

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;

use ed25519_dalek::Signer;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use omnipanel_plugin::PluginManifest;
use sha2::{Digest, Sha256};

use crate::registry::{RegistryArtifact, RegistryPlugin, RegistryVersion};
use crate::{MANIFEST_ENTRY, PkgError, SIGNATURE_ENTRY};

/// 从条目集合打包（name → bytes；路径用 `/`，禁止 `..` 与绝对路径）。
/// `signing_key = None` 产出未签名包（仅 dev 可装载）。
pub fn pack_dir_with_entries(
    entries: BTreeMap<String, Vec<u8>>,
    out: &Path,
    signing_key: Option<&ed25519_dalek::SigningKey>,
) -> Result<(), PkgError> {
    if !entries.contains_key(MANIFEST_ENTRY) {
        return Err(PkgError::MissingEntry(MANIFEST_ENTRY.into()));
    }
    for name in entries.keys() {
        if name.starts_with('/') || name.split('/').any(|seg| seg == "..") {
            return Err(PkgError::Malformed(format!("非法条目路径: {name}")));
        }
    }

    // 规范化字节流（排除签名位）
    let mut message = Vec::new();
    for (name, data) in &entries {
        if name == SIGNATURE_ENTRY {
            continue;
        }
        let name_bytes = name.as_bytes();
        message.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
        message.extend_from_slice(name_bytes);
        message.extend_from_slice(&(data.len() as u32).to_le_bytes());
        message.extend_from_slice(data);
    }

    let file = File::create(out)?;
    let mut writer = ZipWriter::new(BufWriter::new(file));
    for (name, data) in &entries {
        writer
            .start_file(name.as_str(), SimpleFileOptions::default())
            .map_err(PkgError::from)?;
        writer.write_all(data).map_err(PkgError::from)?;
    }
    if let Some(key) = signing_key {
        let signature = key.sign(&message);
        writer
            .start_file(SIGNATURE_ENTRY, SimpleFileOptions::default())
            .map_err(PkgError::from)?;
        writer
            .write_all(&signature.to_bytes())
            .map_err(PkgError::from)?;
    }
    writer.finish().map_err(|e| PkgError::Io(e.to_string()))?;
    Ok(())
}

/// 从源目录打包：递归收集文件（相对路径用 `/`）后走 [`pack_dir_with_entries`]。
pub fn pack_dir(
    dir: &Path,
    out: &Path,
    signing_key: Option<&ed25519_dalek::SigningKey>,
) -> Result<(), PkgError> {
    let mut entries = BTreeMap::new();
    collect_files(dir, dir, &mut entries)?;
    pack_dir_with_entries(entries, out, signing_key)
}

/// 从工程目录打出 registry v2 单插件片段（pack → sha256/size → `RegistryPlugin`）。
/// `signing_key = None` 产出未签名包（仅 dev 可装）。临时 zip 打完即删。
pub fn registry_plugin_from_dir(
    dir: &Path,
    artifact_url: &str,
    changelog: Option<&str>,
    signing_key: Option<&ed25519_dalek::SigningKey>,
) -> Result<RegistryPlugin, PkgError> {
    let manifest_text = std::fs::read_to_string(dir.join(MANIFEST_ENTRY))?;
    let manifest =
        PluginManifest::from_json(&manifest_text).map_err(|e| PkgError::Manifest(e.to_string()))?;
    manifest
        .validate()
        .map_err(|e| PkgError::Manifest(e.to_string()))?;
    let tmp = std::env::temp_dir().join(format!(
        "omni-pub-{}-{}.omni-plugin",
        manifest.id.replace('.', "_"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    pack_dir(dir, &tmp, signing_key)?;
    let plugin = registry_plugin_from_packed(&manifest, artifact_url, changelog, &tmp)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(plugin)
}

/// 已有 `.omni-plugin` 时只算哈希，不再打包。
pub fn registry_plugin_from_packed(
    manifest: &PluginManifest,
    artifact_url: &str,
    changelog: Option<&str>,
    packed: &Path,
) -> Result<RegistryPlugin, PkgError> {
    let bytes = std::fs::read(packed)?;
    Ok(RegistryPlugin {
        id: manifest.id.clone(),
        kind: manifest.kind.as_str().to_string(),
        name: manifest
            .display_name
            .clone()
            .unwrap_or_else(|| manifest.id.clone()),
        description: String::new(),
        versions: vec![RegistryVersion {
            version: manifest.version.clone(),
            changelog: changelog.map(str::to_string).filter(|s| !s.is_empty()),
            min_host_api: manifest.min_host_api,
            artifact: Some(RegistryArtifact {
                url: artifact_url.to_string(),
                sha256: hex::encode(Sha256::digest(&bytes)),
                integrity: String::new(),
                size: bytes.len() as u64,
            }),
            dependencies: manifest.dependencies.clone(),
        }],
        external_npm: None,
    })
}

fn collect_files(
    root: &Path,
    dir: &Path,
    entries: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), PkgError> {
    for entry in std::fs::read_dir(dir).map_err(PkgError::from)? {
        let entry = entry.map_err(PkgError::from)?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, entries)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| PkgError::Malformed("目录越界".into()))?;
            let name = rel.to_string_lossy().replace('\\', "/");
            let data = std::fs::read(&path).map_err(PkgError::from)?;
            entries.insert(name, data);
        }
    }
    Ok(())
}

/// 把包内全部文件条目解压到目标目录（zip-slip 防护：拒绝绝对路径与 `..`）。
/// 先清空目标目录，实现覆盖升级。
pub fn extract_to(archive_path: &Path, dest_dir: &Path) -> Result<(), PkgError> {
    use zip::ZipArchive;

    if dest_dir.exists() {
        std::fs::remove_dir_all(dest_dir).map_err(PkgError::from)?;
    }
    std::fs::create_dir_all(dest_dir).map_err(PkgError::from)?;

    let file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        if name.starts_with('/') || name.split(['/', '\\']).any(|seg| seg == "..") {
            return Err(PkgError::Malformed(format!("非法条目路径: {name}")));
        }
        let target = dest_dir.join(&name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(PkgError::from)?;
        }
        let mut out_file = File::create(&target).map_err(PkgError::from)?;
        std::io::copy(&mut file, &mut out_file).map_err(PkgError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devkey::dev_signing_key;
    use crate::verify_file;

    #[test]
    fn extract_roundtrip_matches_source_entries() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("p.omni-plugin");
        let entries = BTreeMap::from([
            (
                crate::MANIFEST_ENTRY.to_string(),
                br#"{"id":"omni.addon.demo","version":"0.1.0","kind":"addon","permissions":[]}"#
                    .to_vec(),
            ),
            ("assets/sub/icon.svg".to_string(), b"<svg/>".to_vec()),
        ]);
        pack_dir_with_entries(entries.clone(), &out, Some(&dev_signing_key())).unwrap();
        assert!(verify_file(&out).is_ok());

        let dest = temp.path().join("installed").join("omni.addon.demo");
        extract_to(&out, &dest).unwrap();
        for (name, data) in &entries {
            let on_disk = std::fs::read(dest.join(name)).unwrap();
            assert_eq!(&on_disk, data);
        }
        // 覆盖升级：再解压一次不报错
        extract_to(&out, &dest).unwrap();
    }

    #[test]
    fn extract_rejects_zip_slip() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("evil.zip");
        let entries = BTreeMap::from([("../evil.txt".to_string(), b"x".to_vec())]);
        // 打包侧已拒绝非法路径；直接用 zip 写一个恶意条目验证解压侧防护
        {
            let file = File::create(&out).unwrap();
            let mut writer = ZipWriter::new(BufWriter::new(file));
            writer
                .start_file("../evil.txt", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        let dest = temp.path().join("dest");
        assert!(extract_to(&out, &dest).is_err());
        assert!(!temp.path().join("evil.txt").exists());
    }

    #[test]
    fn registry_fragment_contains_sha_and_size() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(MANIFEST_ENTRY),
            br#"{"id":"omni.addon.demo","version":"0.1.0","kind":"addon","permissions":[]}"#,
        )
        .unwrap();
        let fragment = registry_plugin_from_dir(
            &dir,
            "https://example.com/demo.omni-plugin",
            Some("fix overlay"),
            Some(&dev_signing_key()),
        )
        .unwrap();
        assert_eq!(fragment.id, "omni.addon.demo");
        let ver = &fragment.versions[0];
        assert_eq!(ver.version, "0.1.0");
        assert_eq!(ver.changelog.as_deref(), Some("fix overlay"));
        let artifact = ver.artifact.as_ref().unwrap();
        assert_eq!(artifact.sha256.len(), 64);
        assert!(artifact.size > 0);
    }
}
