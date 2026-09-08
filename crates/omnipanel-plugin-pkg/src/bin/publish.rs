//! 发布 CLI：pack → 签名 → 输出 registry v2 片段（含 sha256/size/changelog）。
//!
//! 用法:
//! `cargo run -p omnipanel-plugin-pkg --bin publish -- <plugin_dir> <artifact_url> [changelog]`
//!
//! 标准输出是可合并进 `plugin-registry.json` 的单个 plugin 对象。

use std::path::PathBuf;

use omnipanel_plugin_pkg::devkey::dev_signing_key;
use omnipanel_plugin_pkg::registry_plugin_from_dir;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 || args.len() > 4 {
        eprintln!("用法: publish <plugin_dir> <artifact_url> [changelog]");
        std::process::exit(2);
    }
    let dir = PathBuf::from(&args[1]);
    let url = args[2].clone();
    let changelog = args.get(3).cloned();
    match registry_plugin_from_dir(&dir, &url, changelog.as_deref(), Some(&dev_signing_key())) {
        Ok(fragment) => match serde_json::to_string_pretty(&fragment) {
            Ok(json) => println!("{json}"),
            Err(err) => {
                eprintln!("发布失败: {err}");
                std::process::exit(1);
            }
        },
        Err(err) => {
            eprintln!("发布失败: {err}");
            std::process::exit(1);
        }
    }
}
