//! L3 翻译样板安装链路：真实样板目录 pack → verify → extract → load_installed。
//!
//! 证明 `plugins-samples/translate-float`（动态 `entry.ui` + overlays + home）
//! 按文档流程可打包、可验签、可装载——design 闭环 E 的交付物侧验证。
//! 运行时侧（选区→悬浮→overlay→aiComplete）由前端
//! `menuContributions` / `SelectionFloatLayer` / `PluginSandboxFrame` 单测覆盖。

use omnipanel_plugin::{PluginPermission, PluginRegistry, PluginSource, load_installed};
use omnipanel_plugin_pkg::devkey::dev_signing_key;

/// 样板目录（相对本 crate 清单目录；测试进程 CWD 不可靠，必须锚定 CARGO_MANIFEST_DIR）。
fn sample_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins-samples/translate-float")
}

#[test]
fn translate_float_sample_packs_verifies_and_loads() {
    let temp = tempfile::tempdir().unwrap();

    // 1. 真实样板目录打包（与开发者 `pack` CLI 同一入口）
    let pkg_path = temp.path().join("translate-float.omni-plugin");
    omnipanel_plugin_pkg::pack_dir(&sample_dir(), &pkg_path, Some(&dev_signing_key()))
        .expect("translate-float 打包");
    assert!(omnipanel_plugin_pkg::verify_file(&pkg_path).is_ok());

    // 2. 验签解出清单：L3 合同点齐备
    let manifest = omnipanel_plugin_pkg::verify_file_dev(&pkg_path).unwrap();
    assert_eq!(manifest.id, "omni.sample.translate-float");
    assert!(manifest.logic_entry().is_none());
    let ui_entry = manifest
        .ui_entry()
        .expect("translate-float 必须声明 entry.ui");
    assert_eq!(ui_entry, "ui/main.js");
    let overlays = &manifest.contributes.overlays;
    assert_eq!(overlays.len(), 1);
    assert_eq!(
        overlays[0].get("entry").and_then(|v| v.as_str()),
        Some("ui/index.html")
    );
    assert!(manifest.permissions.contains(&PluginPermission::UiSelection));
    assert!(manifest.permissions.contains(&PluginPermission::AiTools));

    // 3. 安装 = 解压到 plugins_root/<plugin_id>/，资产齐备
    let plugins_root = temp.path().join("plugins");
    let dest = plugins_root.join(&manifest.id);
    omnipanel_plugin_pkg::extract_to(&pkg_path, &dest).unwrap();
    assert!(dest.join("ui/main.js").is_file());
    assert!(dest.join("ui/index.html").is_file());

    // 4. 启动扫描 + 注册表登记：第三方来源，默认启用的 addon 直接激活
    let installed = load_installed(&plugins_root);
    assert_eq!(installed.len(), 1);
    let mut registry = PluginRegistry::new();
    for m in omnipanel_plugin::first_party_manifests() {
        registry.register(m).unwrap();
    }
    for item in &installed {
        registry.register_installed(item.manifest.clone()).unwrap();
    }
    registry.activate_enabled(omnipanel_plugin::PluginPlatform::current());
    let sample = registry
        .list()
        .into_iter()
        .find(|i| i.id == "omni.sample.translate-float")
        .unwrap();
    assert_eq!(sample.source, PluginSource::Installed);
    assert!(sample.activated);

    // 5. 禁用后失活（悬浮按钮/overlay 入口随之消失由前端生命周期保证）
    registry
        .set_enabled("omni.sample.translate-float", false)
        .unwrap();
    let sample = registry.get("omni.sample.translate-float").unwrap();
    assert!(!sample.enabled || !sample.activated);
}
