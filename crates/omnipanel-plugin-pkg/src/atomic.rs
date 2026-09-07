//! 磁盘原子安装：staging 解压 → 预检 → swap（旧版进 last-good）。
//!
//! 目录约定（均在 `packages_dir` 下）：
//! - `<plugin_id>/` 当前可用版本
//! - `.staging/<plugin_id>/` 解压中转（启动时整目录可清）
//! - `.last-good/<plugin_id>/` 上一可用版本（swap 失败时恢复）

use std::fs;
use std::path::{Path, PathBuf};

use omnipanel_plugin::PluginManifest;

use crate::{PkgError, extract_to};

pub const STAGING_DIR: &str = ".staging";
pub const LAST_GOOD_DIR: &str = ".last-good";

pub fn is_reserved_dir_name(name: &str) -> bool {
    name.starts_with('.')
}

pub fn staging_root(packages_dir: &Path) -> PathBuf {
    packages_dir.join(STAGING_DIR)
}

pub fn last_good_root(packages_dir: &Path) -> PathBuf {
    packages_dir.join(LAST_GOOD_DIR)
}

pub fn live_dir(packages_dir: &Path, plugin_id: &str) -> PathBuf {
    packages_dir.join(plugin_id)
}

pub fn staging_dir(packages_dir: &Path, plugin_id: &str) -> PathBuf {
    staging_root(packages_dir).join(plugin_id)
}

pub fn last_good_dir(packages_dir: &Path, plugin_id: &str) -> PathBuf {
    last_good_root(packages_dir).join(plugin_id)
}

/// 启动自愈：丢掉崩溃残留的 `.staging`，不影响已安装版本与 last-good。
pub fn cleanup_staging_root(packages_dir: &Path) -> Result<(), PkgError> {
    let root = staging_root(packages_dir);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(PkgError::from)?;
    }
    Ok(())
}

/// 卸载时清掉 live / staging / last-good，避免残留被下次扫描误认。
pub fn purge_plugin_dirs(packages_dir: &Path, plugin_id: &str) -> Result<(), PkgError> {
    for dir in [
        live_dir(packages_dir, plugin_id),
        staging_dir(packages_dir, plugin_id),
        last_good_dir(packages_dir, plugin_id),
    ] {
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(PkgError::from)?;
        }
    }
    Ok(())
}

fn replace_dir(src: &Path, dst: &Path) -> Result<(), PkgError> {
    if dst.exists() {
        fs::remove_dir_all(dst).map_err(PkgError::from)?;
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(PkgError::from)?;
    }
    fs::rename(src, dst).map_err(PkgError::from)
}

fn read_dir_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("plugin.json")).ok()?;
    PluginManifest::from_json(&text)
        .ok()
        .map(|m| m.version)
}

/// 读 staging 清单并做启用预检（含 minHostApi）。id 必须与目标一致。
pub fn precheck_staging(packages_dir: &Path, plugin_id: &str) -> Result<PluginManifest, PkgError> {
    let dir = staging_dir(packages_dir, plugin_id);
    let text = fs::read_to_string(dir.join("plugin.json"))
        .map_err(|e| PkgError::Malformed(format!("staging 缺少 plugin.json: {e}")))?;
    let manifest =
        PluginManifest::from_json(&text).map_err(|e| PkgError::Manifest(e.to_string()))?;
    if manifest.id != plugin_id {
        return Err(PkgError::Malformed(format!(
            "staging 清单 id 与目标不符: {} != {plugin_id}",
            manifest.id
        )));
    }
    manifest
        .validate()
        .map_err(|e| PkgError::Manifest(e.to_string()))?;
    Ok(manifest)
}

/// 解压到 staging → 预检 → 旧版进 last-good、新版就位。
/// 预检失败时 live 不动；swap 本身失败时尽量把 last-good 推回 live。
pub fn extract_and_swap(
    archive: &Path,
    packages_dir: &Path,
    plugin_id: &str,
) -> Result<PluginManifest, PkgError> {
    if plugin_id.trim().is_empty() || is_reserved_dir_name(plugin_id) {
        return Err(PkgError::Malformed(format!("非法插件 id: {plugin_id}")));
    }
    let staging = staging_dir(packages_dir, plugin_id);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(PkgError::from)?;
    }
    extract_to(archive, &staging)?;
    match precheck_staging(packages_dir, plugin_id) {
        Ok(manifest) => match swap_staging_into_live(packages_dir, plugin_id) {
            Ok(()) => Ok(manifest),
            Err(err) => {
                let _ = restore_last_good(packages_dir, plugin_id);
                Err(err)
            }
        },
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            Err(err)
        }
    }
}

pub fn swap_staging_into_live(packages_dir: &Path, plugin_id: &str) -> Result<(), PkgError> {
    let staging = staging_dir(packages_dir, plugin_id);
    let live = live_dir(packages_dir, plugin_id);
    let last_good = last_good_dir(packages_dir, plugin_id);
    if !staging.is_dir() {
        return Err(PkgError::Malformed(format!(
            "staging 不存在: {}",
            staging.display()
        )));
    }
    if live.exists() {
        replace_dir(&live, &last_good)?;
    }
    replace_dir(&staging, &live)
}

/// 把 last-good 推回 live。无 last-good 时删掉坏的 live（首次安装失败）。
/// 返回是否恢复出可用目录。
pub fn restore_last_good(packages_dir: &Path, plugin_id: &str) -> Result<bool, PkgError> {
    let live = live_dir(packages_dir, plugin_id);
    let last_good = last_good_dir(packages_dir, plugin_id);
    let staging = staging_dir(packages_dir, plugin_id);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    if last_good.is_dir() {
        replace_dir(&last_good, &live)?;
        return Ok(true);
    }
    if live.exists() {
        fs::remove_dir_all(&live).map_err(PkgError::from)?;
    }
    Ok(false)
}

pub fn installed_version(packages_dir: &Path, plugin_id: &str) -> Option<String> {
    read_dir_version(&live_dir(packages_dir, plugin_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devkey::dev_signing_key;
    use crate::pack::pack_dir_with_entries;
    use std::collections::BTreeMap;

    fn pack_manifest(temp: &Path, id: &str, version: &str, extra: &str) -> PathBuf {
        let manifest = format!(
            r#"{{"id":"{id}","version":"{version}","kind":"addon","permissions":[]{extra}}}"#
        );
        let entries = BTreeMap::from([("plugin.json".to_string(), manifest.into_bytes())]);
        let out = temp.join(format!("{id}-{version}.omni-plugin"));
        pack_dir_with_entries(entries, &out, Some(&dev_signing_key())).unwrap();
        out
    }

    #[test]
    fn precheck_failure_keeps_previous_live() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        let v1 = pack_manifest(temp.path(), "omni.addon.demo", "1.0.0", "");
        extract_and_swap(&v1, &root, "omni.addon.demo").unwrap();
        assert_eq!(installed_version(&root, "omni.addon.demo").as_deref(), Some("1.0.0"));

        let v2 = pack_manifest(
            temp.path(),
            "omni.addon.demo",
            "2.0.0",
            r#","minHostApi":99"#,
        );
        let err = extract_and_swap(&v2, &root, "omni.addon.demo").unwrap_err();
        assert!(matches!(err, PkgError::Manifest(_)), "{err}");
        assert_eq!(installed_version(&root, "omni.addon.demo").as_deref(), Some("1.0.0"));
        assert!(!staging_dir(&root, "omni.addon.demo").exists());
    }

    #[test]
    fn successful_upgrade_moves_old_to_last_good() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        let v1 = pack_manifest(temp.path(), "omni.addon.demo", "1.0.0", "");
        extract_and_swap(&v1, &root, "omni.addon.demo").unwrap();
        let v2 = pack_manifest(temp.path(), "omni.addon.demo", "2.0.0", "");
        extract_and_swap(&v2, &root, "omni.addon.demo").unwrap();
        assert_eq!(installed_version(&root, "omni.addon.demo").as_deref(), Some("2.0.0"));
        assert_eq!(
            read_dir_version(&last_good_dir(&root, "omni.addon.demo")).as_deref(),
            Some("1.0.0")
        );
        assert!(!staging_dir(&root, "omni.addon.demo").exists());
    }

    #[test]
    fn restore_last_good_after_bad_live() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        let v1 = pack_manifest(temp.path(), "omni.addon.demo", "1.0.0", "");
        extract_and_swap(&v1, &root, "omni.addon.demo").unwrap();
        let v2 = pack_manifest(temp.path(), "omni.addon.demo", "2.0.0", "");
        extract_and_swap(&v2, &root, "omni.addon.demo").unwrap();

        fs::write(live_dir(&root, "omni.addon.demo").join("broken"), b"x").unwrap();
        assert!(restore_last_good(&root, "omni.addon.demo").unwrap());
        assert_eq!(installed_version(&root, "omni.addon.demo").as_deref(), Some("1.0.0"));
    }

    #[test]
    fn startup_clears_staging_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        let v1 = pack_manifest(temp.path(), "omni.addon.demo", "1.0.0", "");
        extract_and_swap(&v1, &root, "omni.addon.demo").unwrap();
        let leftover = staging_dir(&root, "omni.addon.orphan");
        fs::create_dir_all(&leftover).unwrap();
        fs::write(leftover.join("junk"), b"x").unwrap();
        cleanup_staging_root(&root).unwrap();
        assert!(!staging_root(&root).exists());
        assert_eq!(installed_version(&root, "omni.addon.demo").as_deref(), Some("1.0.0"));
    }

    #[test]
    fn three_plugins_one_precheck_fail_leaves_others() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        for id in ["omni.addon.a", "omni.addon.b", "omni.addon.c"] {
            let pkg = pack_manifest(temp.path(), id, "1.0.0", "");
            extract_and_swap(&pkg, &root, id).unwrap();
        }
        extract_and_swap(
            &pack_manifest(temp.path(), "omni.addon.a", "2.0.0", ""),
            &root,
            "omni.addon.a",
        )
        .unwrap();
        let b_err = extract_and_swap(
            &pack_manifest(temp.path(), "omni.addon.b", "2.0.0", r#","minHostApi":99"#),
            &root,
            "omni.addon.b",
        )
        .unwrap_err();
        assert!(matches!(b_err, PkgError::Manifest(_)));
        extract_and_swap(
            &pack_manifest(temp.path(), "omni.addon.c", "2.0.0", ""),
            &root,
            "omni.addon.c",
        )
        .unwrap();
        assert_eq!(installed_version(&root, "omni.addon.a").as_deref(), Some("2.0.0"));
        assert_eq!(installed_version(&root, "omni.addon.b").as_deref(), Some("1.0.0"));
        assert_eq!(installed_version(&root, "omni.addon.c").as_deref(), Some("2.0.0"));
    }

    #[test]
    fn load_installed_skips_staging_and_last_good() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        let v1 = pack_manifest(temp.path(), "omni.addon.demo", "1.0.0", "");
        extract_and_swap(&v1, &root, "omni.addon.demo").unwrap();
        let leftover = staging_dir(&root, "omni.addon.orphan");
        fs::create_dir_all(&leftover).unwrap();
        fs::write(
            leftover.join("plugin.json"),
            br#"{"id":"omni.addon.orphan","version":"9.0.0","kind":"addon","permissions":[]}"#,
        )
        .unwrap();
        let loaded = omnipanel_plugin::load_installed(&root);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].manifest.id, "omni.addon.demo");
    }
}
