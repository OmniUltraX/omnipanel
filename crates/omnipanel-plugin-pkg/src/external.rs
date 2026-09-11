//! 外部插件（Rubick/uTools 系）兼容判定：纯静态扫描，不执行包内代码。
//!
//! 输入为已解包条目（`path → bytes`，npm tarball 去掉顶层目录后即此形态）。
//! 两步：
//! 1. 形状校验：`package.json`（Rubick：`pluginName` + `features`）或
//!    `plugin.json`（uTools 同源文法）kd features[]` 提取；
//! 2. preload/页面脚本扫描：Node 系黑名单任一命中即 external-only；
//!    `utools.*` 不在白名单即 external-only（默认拒绝方向：误判只会导致
//!    外跳，不会导致越权运行）。

use std::collections::BTreeMap;

use serde::Deserialize;

use super::PkgError;

/// Node 运行时黑名单（命中即需 Node/Electron，直接 external-only）。
/// 形状限定为 require/import 字面，避免打包产物字符串误伤。
const NODE_DENY_PATTERNS: &[&str] = &[
    "require('electron')",
    "require(\"electron\")",
    "from 'electron'",
    "from \"electron\"",
    "require('child_process')",
    "require(\"child_process\")",
    "require('fs')",
    "require(\"fs\")",
    "from 'fs'",
    "from \"fs\"",
    "require('vm')",
    "require(\"vm\")",
];

/// `node:` 内建前缀（import/require 两种写法）。
const NODE_PREFIX_PATTERNS: &[&str] = &["require('node:", "require(\"node:", "from 'node:", "from \"node:"];

/// 宿主可承接的 `utools.*` 白名单（v1，14 项；其它一律 external-only）。
/// 映射：db*→插件私有 state；通知/剪贴板/外链/路径→既有宿主能力；
/// 窗口显隐/subInput/生命周期→ Overlay 壳。
const UTOOLS_ALLOW: &[&str] = &[
    "db.get",
    "db.put",
    "db.remove",
    "db.allDocs",
    "showNotification",
    "copyText",
    "shellOpenExternal",
    "getPath",
    "hideMainWindow",
    "showMainWindow",
    "setSubInput",
    "removeSubInput",
    "onPluginEnter",
    "onPluginOut",
];

/// 外部指令：关键字或匹配器（kind=regex/over/img/files/window）。
#[derive(Debug, Clone, PartialEq)]
pub enum ExternalCmd {
    Keyword(String),
    Match { kind: String, label: String },
}

/// 外部 feature（code/explain/cmds 与 uTools/Rubick 同文）。
#[derive(Debug, Clone, PartialEq)]
pub struct ExternalFeature {
    pub code: String,
    pub explain: String,
    pub cmds: Vec<ExternalCmd>,
}

/// 判定结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ExternalVerdict {
    /// 可转标准包（pure-web，白名单内）。
    pub runnable: bool,
    /// 不可转的原因（为空即 runnable）。
    pub reasons: Vec<String>,
    pub plugin_name: String,
    pub features: Vec<ExternalFeature>,
    /// 主 HTML 入口（相对路径），转换 overlays 用。
    pub main_entry: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RubickPackage {
    #[serde(default)]
    #[serde(rename = "pluginName")]
    plugin_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    features: Vec<FeatureRaw>,
    #[serde(default)]
    preload: Option<String>,
    #[serde(default)]
    main: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UToolsManifest {
    #[serde(default, rename = "pluginName")]
    plugin_name: Option<String>,
    #[serde(default)]
    features: Vec<FeatureRaw>,
    #[serde(default)]
    preload: Option<String>,
    #[serde(default)]
    main: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeatureRaw {
    #[serde(default)]
    code: String,
    #[serde(default)]
    explain: String,
    #[serde(default)]
    cmds: Vec<serde_json::Value>,
}

fn parse_cmd(value: &serde_json::Value) -> Option<ExternalCmd> {
    if let Some(keyword) = value.as_str() {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return None;
        }
        return Some(ExternalCmd::Keyword(keyword.to_string()));
    }
    let obj = value.as_object()?;
    let kind = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if kind.is_empty() {
        return None;
    }
    let label = obj
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or(&kind)
        .to_string();
    Some(ExternalCmd::Match { kind, label })
}

fn as_text(bytes: &[u8]) -> Option<&str> {
    std::str::from_utf8(bytes).ok()
}

/// 提取 `utools.xxx[.yyy]` 调用名（点链保留，如 `db.put`）。
fn called_utools_apis(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("utools.") {
        let after = &rest[pos + "utools.".len()..];
        let end = after
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$' && c != '.')
            .unwrap_or(after.len());
        let name = after[..end].trim_matches('.');
        if !name.is_empty() && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
        rest = after;
    }
    out
}

fn is_script_entry(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".js") || lower.ends_with(".html") || lower.ends_with(".htm")
}

/// 判定外部包。`entries` 为解包条目（npm tarball 顶层目录已剥离）。
pub fn analyze_external_entries(
    entries: &BTreeMap<String, Vec<u8>>,
) -> Result<ExternalVerdict, PkgError> {
    // 1. 形状：package.json（Rubick）优先，plugin.json（uTools）回退。
    let (plugin_name, features_raw, preload, main) = if let Some(raw) = entries.get("package.json") {
        let text = as_text(raw).ok_or_else(|| PkgError::Malformed("package.json 非 UTF-8".into()))?;
        let pkg: RubickPackage = serde_json::from_str(text)
            .map_err(|e| PkgError::Malformed(format!("package.json 非法: {e}")))?;
        let name = pkg
            .plugin_name
            .or(pkg.name)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| PkgError::Malformed("缺少 pluginName/name".into()))?;
        (name, pkg.features, pkg.preload, pkg.main)
    } else if let Some(raw) = entries.get("plugin.json") {
        let text = as_text(raw).ok_or_else(|| PkgError::Malformed("plugin.json 非 UTF-8".into()))?;
        let manifest: UToolsManifest = serde_json::from_str(text)
            .map_err(|e| PkgError::Malformed(format!("plugin.json 非法: {e}")))?;
        let name = manifest
            .plugin_name
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| PkgError::Malformed("缺少 pluginName".into()))?;
        (name, manifest.features, manifest.preload, manifest.main)
    } else {
        return Err(PkgError::MissingEntry("package.json/plugin.json".into()));
    };

    let mut reasons = Vec::new();
    let main_present = main
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();
    // 无 features 且无主入口：无可映射、无处展示，不可转；
    // 有主入口即使无 features，仍可转 overlay-only 安装。
    if features_raw.is_empty() && !main_present {
        reasons.push("features 为空且无主入口：无可映射的指令".into());
    }
    let features: Vec<ExternalFeature> = features_raw
        .into_iter()
        .map(|f| ExternalFeature {
            code: f.code,
            explain: f.explain,
            cmds: f.cmds.iter().filter_map(parse_cmd).collect(),
        })
        .collect();

    // 2. 脚本扫描：全部 .js/.html 入口。
    let scripts: Vec<(&String, &str)> = entries
        .iter()
        .filter(|(path, _)| is_script_entry(path))
        .filter_map(|(path, bytes)| as_text(bytes).map(|text| (path, text)))
        .collect();
    for (path, text) in &scripts {
        for pattern in NODE_DENY_PATTERNS {
            if text.contains(pattern) {
                reasons.push(format!("需 Node 运行时 ({path} 含 {pattern})"));
                break;
            }
        }
        for pattern in NODE_PREFIX_PATTERNS {
            if text.contains(pattern) {
                reasons.push(format!("需 Node 内建模块 ({path} 含 {pattern})"));
                break;
            }
        }
    }
    // preload 声明缺失文件同样判外部（形残包不转）。
    if let Some(preload) = preload.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let norm = preload.trim_start_matches("./").trim_start_matches('/');
        let found = entries.keys().any(|p| {
            let p = p.trim_start_matches("./").trim_start_matches('/');
            p == norm || p.ends_with(&format!("/{norm}"))
        });
        if !found {
            reasons.push(format!("preload 声明缺失文件: {preload}"));
        }
    }
    for (_, text) in &scripts {
        for api in called_utools_apis(text) {
            if !UTOOLS_ALLOW.contains(&api.as_str()) {
                reasons.push(format!("不支持的 utools.{api}（白名单外）"));
            }
        }
    }
    reasons.sort();
    reasons.dedup();

    let main_entry = main.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(ExternalVerdict {
        runnable: reasons.is_empty(),
        reasons,
        plugin_name,
        features,
        main_entry,
    })
}

// ── converter ──────────────────────────────────────────────────────────
// runnable verdict → 标准 .omni-plugin 条目（plugin.json + ui/main.js +
// 静态资源拷贝）。输出条目可直接 pack_dir_with_entries 打包走现有安装管线。

/// 单资产上限（与 `plugin_read_asset` 512KB 上限对齐，超限即拒绝转换）。
pub const CONVERT_ASSET_MAX_BYTES: usize = 512 * 1024;

/// 不进转换包的条目（preload 不可执行；元数据/依赖目录无用）。
fn convert_denied(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower == "package.json"
        || lower == "plugin.json"
        || lower.starts_with("node_modules/")
        || lower.starts_with(".git/")
        || lower.ends_with(".asar")
}

/// npm 包名 → 插件 id 后缀（小写 alnum/-/_/.，其余转 `-`）。
fn sanitize_external_id(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "external".to_string()
    } else {
        trimmed
    }
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// 生成的动态入口：关键字菜单 → 打开主 overlay。合同见前端
/// `evaluateDynamicPluginModule`（CommonJS，`module.exports = definePlugin`）。
fn generated_ui_main(plugin_id: &str, overlay_id: &str, keywords: &[String]) -> String {
    let mut items = String::new();
    for (index, keyword) in keywords.iter().enumerate() {
        items.push_str(&format!(
            "    {{ id: {}, label: {}, onClick: openMain }},\n",
            js_string(&format!("ext-kw-{index}")),
            js_string(keyword),
        ));
    }
    format!(
        r#"// 由 external converter 生成：外部关键字 → 主 overlay。
// deactivate 成对卸载本次登记的菜单项。
var OVERLAY_ID = {overlay};
var PLUGIN_ID = {plugin};
var cachedHost = null;
function openMain() {{
  if (typeof host !== "undefined" && host.ui && host.ui.overlay) {{
    return host.ui.overlay.open(OVERLAY_ID);
  }}
  throw new Error("overlay host 不可用: " + PLUGIN_ID);
}}
var MENU_ITEMS = [
{items}];
module.exports = definePlugin({{
  activate: function (ctx) {{
    cachedHost = ctx.host;
    for (var i = 0; i < MENU_ITEMS.length; i++) {{
      ctx.host.ui.menu.register(MENU_ITEMS[i]);
    }}
  }},
  deactivate: function () {{
    if (cachedHost) {{
      for (var i = 0; i < MENU_ITEMS.length; i++) {{
        try {{
          cachedHost.ui.menu.unregister(MENU_ITEMS[i].id);
        }} catch (e) {{
          void e;
        }}
      }}
      cachedHost = null;
    }}
  }}
}});
"#,
        overlay = js_string(overlay_id),
        plugin = js_string(plugin_id),
        items = items,
    )
}

/// 转换外部包为标准 `.omni-plugin` 条目（`path → bytes`，含 `plugin.json`）。
/// 仅接受 runnable verdict；`npm_name` 为 npm 包名（`@scope/name` 亦可），
/// `version` 为目标版本。`x-origin` 记来源（展示/审计用，非 schema 字段）。
pub fn convert_external_to_entries(
    verdict: &ExternalVerdict,
    entries: &BTreeMap<String, Vec<u8>>,
    npm_name: &str,
    version: &str,
) -> Result<BTreeMap<String, Vec<u8>>, PkgError> {
    if !verdict.runnable {
        return Err(PkgError::Malformed(format!(
            "不可转换（external-only）：{}",
            verdict.reasons.join("；")
        )));
    }
    let plugin_id = format!("omni.ext.{}", sanitize_external_id(npm_name));
    let overlay_id = "main";
    let keywords: Vec<String> = verdict
        .features
        .iter()
        .flat_map(|f| f.cmds.iter())
        .filter_map(|c| match c {
            ExternalCmd::Keyword(k) => Some(k.clone()),
            ExternalCmd::Match { .. } => None,
        })
        .collect();

    let mut out = BTreeMap::new();
    // 静态资源：主 HTML 必含；其余放行（超限单项拒绝，不静默丢）。
    let mut copied_main = false;
    for (path, bytes) in entries {
        if convert_denied(path) {
            continue;
        }
        if bytes.len() > CONVERT_ASSET_MAX_BYTES {
            return Err(PkgError::Malformed(format!(
                "资产超过 512KB 上限，拒绝转换: {path}"
            )));
        }
        if Some(path.as_str()) == verdict.main_entry.as_deref() {
            copied_main = true;
        }
        out.insert(path.clone(), bytes.clone());
    }
    if verdict.main_entry.is_some() && !copied_main {
        return Err(PkgError::MissingEntry(
            verdict.main_entry.clone().unwrap_or_default(),
        ));
    }
    out.insert(
        "ui/main.js".to_string(),
        generated_ui_main(&plugin_id, overlay_id, &keywords).into_bytes(),
    );

    let manifest = serde_json::json!({
        "id": plugin_id,
        "version": version,
        "displayName": verdict.plugin_name,
        "kind": "addon",
        "permissions": [],
        "entry": { "ui": "ui/main.js" },
        "contributes": {
            "overlays": verdict.main_entry.as_ref().map(|entry| {
                serde_json::json!([{ "id": overlay_id, "title": verdict.plugin_name, "entry": entry }])
            }).unwrap_or(serde_json::json!([])),
            "ui": { "home": verdict.main_entry.as_ref().map(|_| {
                serde_json::json!({
                    "show": true,
                    "title": verdict.plugin_name,
                    "open": { "kind": "overlay", "id": overlay_id },
                })
            }) },
        },
        "x-origin": format!("rubick:{npm_name}@{version}"),
    });
    out.insert(
        "plugin.json".to_string(),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|e| PkgError::Malformed(format!("清单序列化失败: {e}")))?,
    );
    Ok(out)
}

/// npm tarball 解包为条目（`path → bytes`）：gunzip 后剥掉顶层目录
///（通常为 `package/`）。拒绝 symlink/超大单项（>8MB）与总量超限（>64MB），
///条目超 5000 即拒（防 zip-bomb 式膨胀）。
pub fn unpack_npm_tarball(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, PkgError> {
    const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_ENTRIES: usize = 5000;
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    let mut out = BTreeMap::new();
    let mut total: u64 = 0;
    let entries = archive
        .entries()
        .map_err(|e| PkgError::Malformed(format!("tar 读取失败: {e}")))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| PkgError::Malformed(format!("tar 条目失败: {e}")))?;
        if out.len() >= MAX_ENTRIES {
            return Err(PkgError::Malformed("tar 条目过多，拒绝解包".into()));
        }
        let path = entry
            .path()
            .map_err(|e| PkgError::Malformed(format!("tar 路径非法: {e}")))?;
        let mut parts = path.components();
        // 剥顶层目录；无顶层（扁平包）则整路径保留。
        let first = parts.next();
        let rest: std::path::PathBuf = parts.collect();
        let rel = if rest.as_os_str().is_empty() {
            first
                .map(|c| std::path::PathBuf::from(c.as_os_str()))
                .unwrap_or_default()
        } else {
            rest
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let rel_str = rel_str.trim_matches('/').to_string();
        if rel_str.is_empty()
            || rel_str.split('/').any(|seg| seg == ".." || seg.is_empty())
        {
            continue;
        }
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(PkgError::Malformed(format!("tar 单项过大，拒绝解包: {rel_str}")));
        }
        let mut data = Vec::new();
        use std::io::Read;
        entry
            .read_to_end(&mut data)
            .map_err(|e| PkgError::Malformed(format!("tar 读取失败: {e}")))?;
        total += data.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(PkgError::Malformed("tar 总量超限，拒绝解包".into()));
        }
        out.insert(rel_str, data);
    }
    if out.is_empty() {
        return Err(PkgError::Malformed("tar 为空包".into()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(pairs: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
            .collect()
    }

    const PURE_PKG: &str = r#"{"name":"demo-pure","pluginName":"纯展示","version":"1.0.0","main":"index.html","features":[{"code":"calc","explain":"计算","cmds":["calc","计算"]}]}"#;
    const PURE_HTML: &str = r#"<div><script>utools.showNotification('hi');utools.db.put('k','v');</script></div>"#;

    #[test]
    fn pure_web_package_is_runnable() {
        let verdict =
            analyze_external_entries(&entries(&[("package.json", PURE_PKG), ("index.html", PURE_HTML)]))
                .unwrap();
        assert!(verdict.runnable, "reasons: {:?}", verdict.reasons);
        assert_eq!(verdict.plugin_name, "纯展示");
        assert_eq!(verdict.features.len(), 1);
        assert_eq!(
            verdict.features[0].cmds,
            vec![
                ExternalCmd::Keyword("calc".into()),
                ExternalCmd::Keyword("计算".into()),
            ]
        );
        assert_eq!(verdict.main_entry.as_deref(), Some("index.html"));
    }

    #[test]
    fn node_preload_is_external_only() {
        let pkg = r#"{"name":"demo-node","pluginName":"Node插件","preload":"preload.js","features":[{"code":"x","explain":"x","cmds":["x"]}]}"#;
        let preload = r#"const { ipcRenderer } = require('electron');utools.db.get('k');"#;
        let verdict =
            analyze_external_entries(&entries(&[("package.json", pkg), ("preload.js", preload)]))
                .unwrap();
        assert!(!verdict.runnable);
        assert!(verdict.reasons.iter().any(|r| r.contains("electron")));
    }

    #[test]
    fn unknown_utools_api_is_external_only() {
        let pkg = r#"{"name":"demo-unk","pluginName":"未知API","main":"index.html","features":[{"code":"x","explain":"x","cmds":["x"]}]}"#;
        let html = r#"<script>utools.screenCapture(function(){})</script>"#;
        let verdict =
            analyze_external_entries(&entries(&[("package.json", pkg), ("index.html", html)]))
                .unwrap();
        assert!(!verdict.runnable);
        assert!(verdict.reasons.iter().any(|r| r.contains("utools.screenCapture")));
    }

    #[test]
    fn utools_plugin_json_shape_accepted() {
        let manifest = r#"{"pluginName":"旧格式","main":"index.html","features":[{"code":"o","explain":"o","cmds":[{"type":"over","label":"问问AI"}]}]}"#;
        let verdict =
            analyze_external_entries(&entries(&[("plugin.json", manifest), ("index.html", "<div/>")]))
                .unwrap();
        assert!(verdict.runnable, "reasons: {:?}", verdict.reasons);
        assert_eq!(
            verdict.features[0].cmds,
            vec![ExternalCmd::Match { kind: "over".into(), label: "问问AI".into() }]
        );
    }

    #[test]
    fn missing_manifest_rejected() {
        let err = analyze_external_entries(&entries(&[("index.html", "<div/>")])).unwrap_err();
        assert!(matches!(err, PkgError::MissingEntry(_)));
    }

    #[test]
    fn main_without_features_is_runnable_overlay_only() {
        let pkg = r#"{"name":"demo-page","pluginName":"单页","main":"index.html","features":[]}"#;
        let verdict =
            analyze_external_entries(&entries(&[("package.json", pkg), ("index.html", "<div/>")]))
                .unwrap();
        assert!(verdict.runnable, "reasons: {:?}", verdict.reasons);
    }

    fn make_tgz(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (name, data) in files {
                let path = format!("package/{name}");
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, path, *data).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_buf).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn unpack_strips_top_dir_and_rejects_links() {
        let tgz = make_tgz(&[("package.json", PURE_PKG.as_bytes()), ("index.html", PURE_HTML.as_bytes())]);
        let out = unpack_npm_tarball(&tgz).unwrap();
        assert!(out.contains_key("package.json"));
        assert!(out.contains_key("index.html"));
        assert!(!out.keys().any(|k| k.starts_with("package/")));
        // 全链：解包 → 判定 runnable
        let verdict = analyze_external_entries(&out).unwrap();
        assert!(verdict.runnable, "reasons: {:?}", verdict.reasons);
    }

    #[test]
    fn unpack_rejects_garbage() {
        let err = unpack_npm_tarball(b"not-a-tarball").unwrap_err();
        assert!(matches!(err, PkgError::Malformed(_)));
    }

    fn pure_web_full() -> BTreeMap<String, Vec<u8>> {
        entries(&[
            ("package.json", PURE_PKG),
            ("index.html", PURE_HTML),
        ])
    }

    #[test]
    fn convert_runnable_to_standard_package() {
        let input = pure_web_full();
        let verdict = analyze_external_entries(&input).unwrap();
        assert!(verdict.runnable);
        let out =
            convert_external_to_entries(&verdict, &input, "demo-pure", "1.2.3").unwrap();
        assert!(out.contains_key("plugin.json"));
        assert!(out.contains_key("ui/main.js"));
        assert!(out.contains_key("index.html"));
        assert!(!out.contains_key("package.json"));
        let manifest_text = std::str::from_utf8(&out["plugin.json"]).unwrap();
        let manifest =
            omnipanel_plugin::PluginManifest::from_json(manifest_text).expect("标准清单可解析");
        assert_eq!(manifest.id, "omni.ext.demo-pure");
        assert_eq!(manifest.version, "1.2.3");
        // 全链路：转出包可打包验签（dev 路径）
        let tmp = tempfile::tempdir().unwrap();
        let pkg_path = tmp.path().join("converted.omni-plugin");
        crate::pack::pack_dir_with_entries(out, &pkg_path, Some(&crate::devkey::dev_signing_key()))
            .unwrap();
        let installed = crate::verify_file_dev(&pkg_path).unwrap();
        assert_eq!(installed.id, "omni.ext.demo-pure");
    }

    #[test]
    fn convert_external_only_rejected() {
        let pkg = r#"{"name":"demo-node","pluginName":"Node插件","preload":"preload.js","features":[{"code":"x","explain":"x","cmds":["x"]}]}"#;
        let preload = r#"const { ipcRenderer } = require('electron');"#;
        let input = entries(&[("package.json", pkg), ("preload.js", preload)]);
        let verdict = analyze_external_entries(&input).unwrap();
        assert!(!verdict.runnable);
        let err = convert_external_to_entries(&verdict, &input, "demo-node", "1.0.0").unwrap_err();
        assert!(matches!(err, PkgError::Malformed(_)));
    }

    #[test]
    fn convert_scoped_npm_name_sanitized() {
        let input = pure_web_full();
        let verdict = analyze_external_entries(&input).unwrap();
        let out =
            convert_external_to_entries(&verdict, &input, "@scope/Name.X", "0.0.1").unwrap();
        let manifest_text = std::str::from_utf8(&out["plugin.json"]).unwrap();
        let manifest = omnipanel_plugin::PluginManifest::from_json(manifest_text).unwrap();
        assert_eq!(manifest.id, "omni.ext.scope-name.x");
    }
}
