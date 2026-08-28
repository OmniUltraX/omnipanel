//! L1 开放链路端到端：pack → extract → load_installed → PluginRegistry 贡献点。

use std::collections::BTreeMap;

use omnipanel_plugin::{PluginRegistry, PluginSource, load_installed};
use omnipanel_plugin_pkg::devkey::dev_signing_key;
use omnipanel_plugin_pkg::pack::pack_dir_with_entries;

const SAMPLE_MANIFEST: &str = include_str!("../../../plugins-samples/l1-starter/plugin.json");

#[test]
fn l1_sample_installs_and_contributes() {
    let temp = tempfile::tempdir().unwrap();

    // 1. 打包样板（模拟第三方开发者产出）
    let entries = BTreeMap::from([(
        "plugin.json".to_string(),
        SAMPLE_MANIFEST.as_bytes().to_vec(),
    )]);
    let pkg_path = temp.path().join("l1-starter.omni-plugin");
    pack_dir_with_entries(entries, &pkg_path, Some(&dev_signing_key())).unwrap();
    assert!(omnipanel_plugin_pkg::verify_file(&pkg_path).is_ok());

    // 2. 安装 = 解压到 plugins_root/<plugin_id>/
    let manifest = omnipanel_plugin_pkg::verify_file_dev(&pkg_path).unwrap();
    assert_eq!(manifest.id, "omni.engine.l1-starter");
    let plugins_root = temp.path().join("plugins");
    let dest = plugins_root.join(&manifest.id);
    omnipanel_plugin_pkg::extract_to(&pkg_path, &dest).unwrap();

    // 3. 启动扫描 + 注册表登记
    let installed = load_installed(&plugins_root);
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].manifest.id, "omni.engine.l1-starter");

    let mut registry = PluginRegistry::new();
    for m in omnipanel_plugin::first_party_manifests() {
        registry.register(m).unwrap();
    }
    for item in &installed {
        registry.register_installed(item.manifest.clone()).unwrap();
    }
    registry.activate_enabled(omnipanel_plugin::PluginPlatform::current());

    // 4. 列表含来源标记；贡献点（AI 工具）已并入
    let list = registry.list();
    let sample = list
        .iter()
        .find(|i| i.id == "omni.engine.l1-starter")
        .unwrap();
    assert_eq!(sample.source, PluginSource::Installed);
    assert!(sample.activated);

    let ai_tools = &registry.contributions().ai_tools;
    assert!(
        ai_tools
            .iter()
            .any(|(pid, tool)| pid == "omni.engine.l1-starter" && tool.name == "l1_starter_ping")
    );

    // 5. 禁用后贡献点消失，连接数据无关
    registry
        .set_enabled("omni.engine.l1-starter", false)
        .unwrap();
    assert!(
        !registry
            .contributions()
            .ai_tools
            .iter()
            .any(|(pid, _)| pid == "omni.engine.l1-starter")
    );
}

#[test]
fn l1_sample_builtin_id_collision_keeps_builtin() {
    // 安装包 id 与内置插件冲突：registry 层 or_insert 保留内置条目；
    // 命令层（plugin_install_from_file）在此判定之前已显式拒绝。
    let mut registry = PluginRegistry::new();
    registry
        .register(omnipanel_plugin::engine_qdrant())
        .unwrap();
    registry
        .register_installed(
            omnipanel_plugin::PluginManifest::from_json(
                r#"{"id":"omni.engine.qdrant","version":"9.9.9","kind":"engine","permissions":[]}"#,
            )
            .unwrap(),
        )
        .unwrap();
    let entry = registry.get("omni.engine.qdrant").unwrap();
    assert_eq!(entry.source, PluginSource::Builtin);
    assert_eq!(entry.manifest.version, "0.1.0");
    assert!(!registry.is_installed("omni.engine.qdrant"));
}
