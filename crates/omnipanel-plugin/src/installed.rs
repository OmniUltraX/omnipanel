//! 磁盘安装插件装载：扫描 `<plugins_root>/<dir>/plugin.json`。

use std::path::{Path, PathBuf};

use crate::manifest::PluginManifest;

pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    /// 插件目录（卸载/升级时整目录替换）。
    pub dir: PathBuf,
}

/// 扫描安装根目录；单包清单非法仅跳过该包（不阻塞其余）。
pub fn load_installed(plugins_root: &Path) -> Vec<InstalledPlugin> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(plugins_root) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let manifest_path = dir.join("plugin.json");
        if !manifest_path.is_file() {
            continue;
        }
        match std::fs::read_to_string(&manifest_path)
            .map_err(|e| e.to_string())
            .and_then(|text| {
                PluginManifest::from_json(&text).map_err(|e| e.to_string())
            }) {
            Ok(manifest) => out.push(InstalledPlugin { manifest, dir }),
            Err(err) => {
                eprintln!(
                    "[plugin-installed] 跳过非法包 {}: {err}",
                    dir.display()
                );
            }
        }
    }
    out
}
