//! 本地文件数据源：宿主遍历用户授权目录，把文件内容喂给插件 `parseMethod`。
//!
//! 安全：
//! - 根目录来自源配置（用户显式授权），`rel` 逐段校验，禁止 `..` 与绝对路径，
//!   读取前 canonicalize 确认不出根；
//! - 单文件上限 8MB，超限跳过并计数（ks_test 展示），不进解析。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::adapter::{KsDocContent, KsDocRef, KsNotebook, MethodCaller, SourceAdapter};

/// 单文件上限（8MB），超限跳过并计数。
pub const MAX_PARSE_BYTES: u64 = 8 * 1024 * 1024;

/// walk 产物。
#[derive(Debug, Clone)]
pub struct LocalFile {
    /// 盒子内相对路径（`/` 分隔）。
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub mtime_ms: i64,
    pub size: u64,
}

fn file_mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// 后缀过滤（不带点，小写比较）；空列表 = 全收（点文件与超大仍跳过）。
/// 含 `/` 的 pattern 按完整相对路径后缀匹配（如 `.siyuan/conf.json`），
/// 让笔记本元数据这类固定路径文件总能进来；纯后缀只看文件名。
fn suffix_allowed(rel_slash: &str, file_name: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return true;
    }
    let lower_name = file_name.to_ascii_lowercase();
    let lower_rel = rel_slash.to_ascii_lowercase();
    patterns.iter().any(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return false;
        }
        // 含 `/` 的按完整相对路径后缀匹配（点号保留，如 `.siyuan/conf.json`）。
        if trimmed.contains('/') {
            let p = trimmed.to_ascii_lowercase();
            let stripped: String = p.trim_start_matches('.').to_string();
            return lower_rel.ends_with(&p)
                || (!stripped.is_empty() && lower_rel.ends_with(&format!("/{stripped}")));
        }
        let p = trimmed.trim_start_matches('.').to_ascii_lowercase();
        !p.is_empty() && (lower_name == p || lower_name.ends_with(&format!(".{p}")))
    })
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    rel_dir: &Path,
    patterns: &[String],
    out: &mut Vec<LocalFile>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            // 点目录默认跳过，但 `.siyuan` 是笔记本元数据目录，必须进去
            // （里面的 conf.json 由 filePatterns 决定是否收）。
            if is_hidden(&name) && name != ".siyuan" {
                continue;
            }
            walk_dir(root, &entry.path(), &rel_dir.join(&name), patterns, out);
            continue;
        }
        if is_hidden(&name) {
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let rel = rel_dir.join(&name);
        let rel_slash = rel.to_string_lossy().replace('\\', "/");
        if !suffix_allowed(&rel_slash, &name, patterns) {
            continue;
        }
        let abs_path = root.join(&rel);
        let (mtime_ms, size) = std::fs::metadata(&abs_path)
            .map(|m| {
                (
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                    m.len(),
                )
            })
            .unwrap_or((file_mtime_ms(&abs_path), 0));
        out.push(LocalFile {
            rel_path: rel_slash,
            abs_path,
            mtime_ms,
            size,
        });
    }
}

/// 遍历授权根目录（不存在/不可读返回空列表，调用方判空提示）。
pub fn walk_local_files(root: &Path, patterns: &[String]) -> Vec<LocalFile> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    walk_dir(root, root, Path::new(""), patterns, &mut out);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

/// 在授权根内读取相对路径文件（防穿越）。
pub fn read_local_file(root: &Path, rel_path: &str) -> Result<String, String> {
    let mut rel = PathBuf::new();
    for comp in Path::new(rel_path).components() {
        match comp {
            Component::Normal(seg) => rel.push(seg),
            _ => {
                return Err(format!("非法相对路径: {rel_path}"));
            }
        }
    }
    if rel.as_os_str().is_empty() {
        return Err(format!("非法相对路径: {rel_path}"));
    }
    let abs_path = root.join(&rel);
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("根目录不可读: {e}"))?;
    let canonical_file = abs_path
        .canonicalize()
        .map_err(|e| format!("读取 {rel_path} 失败: {e}"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(format!("路径越界: {rel_path}"));
    }
    std::fs::read_to_string(&canonical_file).map_err(|e| format!("读取 {rel_path} 失败: {e}"))
}

/// 解析结果缓存（一次同步内一次全量 walk+parse）。
#[derive(Default)]
struct ParseCache {
    notebooks: Vec<(String, String, Option<String>)>,
    docs: HashMap<String, CachedDoc>,
    done: bool,
}

struct CachedDoc {
    doc_ref: KsDocRef,
    content: KsDocContent,
}

/// 本地文件插件适配器：宿主 walk+read，插件 `parseMethod` 逐文件分类解析。
///
/// parse 契约：`({ relPath, content })` →
/// `{ kind: "notebook", id, name }` |
/// `{ kind: "doc", id, title, markdown }` |
/// `{ kind: "skip" }`。顶层目录自动补文件夹（显式命名优先）。
pub struct PluginLocalAdapter<C> {
    plugin_id: String,
    namespace: String,
    id_prefix: String,
    source_prefix: String,
    tag: String,
    parse_method: String,
    root: PathBuf,
    file_patterns: Vec<String>,
    caller: C,
    cache: Mutex<ParseCache>,
    skipped_large: Mutex<usize>,
}

impl<C> PluginLocalAdapter<C> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        plugin_id: impl Into<String>,
        namespace: impl Into<String>,
        id_prefix: impl Into<String>,
        source_prefix: impl Into<String>,
        tag: impl Into<String>,
        parse_method: impl Into<String>,
        root: PathBuf,
        file_patterns: Vec<String>,
        caller: C,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            namespace: namespace.into(),
            id_prefix: id_prefix.into(),
            source_prefix: source_prefix.into(),
            tag: tag.into(),
            parse_method: parse_method.into(),
            root,
            file_patterns,
            caller,
            cache: Mutex::new(ParseCache::default()),
            skipped_large: Mutex::new(0),
        }
    }

    /// 超大跳过计数（ks_test 展示用）。
    pub fn skipped_large(&self) -> usize {
        *self.skipped_large.lock().unwrap()
    }

    fn top_dir(rel: &str) -> String {
        rel.split('/').next().unwrap_or("").to_string()
    }
}

impl<C: MethodCaller> PluginLocalAdapter<C> {
    fn ensure_cache(&self) -> Result<(), String> {
        {
            let cache = self.cache.lock().unwrap();
            if cache.done {
                return Ok(());
            }
        }
        let files = walk_local_files(&self.root, &self.file_patterns);
        if files.is_empty() {
            return Err(format!("目录下未发现可同步文件: {}", self.root.display()));
        }
        let mut notebooks: Vec<(String, String, Option<String>)> = Vec::new();
        let mut seen_notebooks: HashSet<String> = HashSet::new();
        let mut docs: HashMap<String, CachedDoc> = HashMap::new();
        let mut skipped = 0usize;
        for file in files {
            if file.size > MAX_PARSE_BYTES {
                skipped += 1;
                continue;
            }
            let content = read_local_file(&self.root, &file.rel_path)?;
            let value = self.caller.call(
                &self.plugin_id,
                &self.parse_method,
                serde_json::json!({ "relPath": file.rel_path, "content": content }),
            )?;
            let kind = value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            match kind {
                "notebook" => {
                    let id = value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if id.is_empty() || !seen_notebooks.insert(id.clone()) {
                        continue;
                    }
                    let name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    notebooks.push((
                        id,
                        if name.is_empty() {
                            Self::top_dir(&file.rel_path)
                        } else {
                            name
                        },
                        None,
                    ));
                }
                "doc" => {
                    let id = value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if id.is_empty() || docs.contains_key(&id) {
                        continue;
                    }
                    let title = value
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let markdown = value
                        .get("markdown")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let box_id = Self::top_dir(&file.rel_path);
                    docs.insert(
                        id.clone(),
                        CachedDoc {
                            doc_ref: KsDocRef {
                                id: id.clone(),
                                title: title.clone(),
                                parent_id: None,
                                box_id: box_id.clone(),
                                rel_path: file.rel_path.clone(),
                                fingerprint: file.mtime_ms.to_string(),
                            },
                            content: KsDocContent {
                                title,
                                markdown,
                                updated_at_ms: None,
                            },
                        },
                    );
                }
                _ => {} // "skip" 与未知均忽略
            }
        }
        // 顶层目录自动补文件夹（显式命名优先）。
        let mut auto: HashSet<String> = HashSet::new();
        for doc in docs.values() {
            if !doc.doc_ref.box_id.is_empty() {
                auto.insert(doc.doc_ref.box_id.clone());
            }
        }
        for box_id in auto {
            if seen_notebooks.contains(&box_id) {
                continue;
            }
            seen_notebooks.insert(box_id.clone());
            notebooks.push((box_id.clone(), box_id, None));
        }
        let mut cache = self.cache.lock().unwrap();
        cache.notebooks = notebooks;
        cache.docs = docs;
        cache.done = true;
        *self.skipped_large.lock().unwrap() = skipped;
        Ok(())
    }
}

impl<C: MethodCaller> SourceAdapter for PluginLocalAdapter<C> {
    fn namespace(&self) -> &str {
        &self.namespace
    }

    fn folder_entry_id(&self, box_id: &str) -> String {
        format!("{}-box-{box_id}", self.id_prefix)
    }

    fn doc_entry_id(&self, doc_id: &str) -> String {
        format!("{}-doc-{doc_id}", self.id_prefix)
    }

    fn archive_folder_id(&self, box_id: &str) -> String {
        format!("{}-archive-{box_id}", self.id_prefix)
    }

    fn folder_source(&self, box_id: &str) -> String {
        format!("{}:box:{box_id}", self.source_prefix)
    }

    fn doc_source(&self, box_id: &str, doc_id: &str) -> String {
        format!("{}:doc:{box_id}/{doc_id}", self.source_prefix)
    }

    fn archive_source(&self, box_id: &str) -> String {
        format!("{}:archive:{box_id}", self.source_prefix)
    }

    fn tag(&self) -> String {
        self.tag.clone()
    }

    fn archive_tag(&self) -> String {
        format!("{}:archived", self.tag)
    }

    fn file_key(&self, doc: &KsDocRef) -> String {
        format!("local:{}:{}", doc.box_id, doc.rel_path)
    }

    fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
        self.ensure_cache()?;
        let cache = self.cache.lock().unwrap();
        Ok(cache
            .notebooks
            .iter()
            .map(|(id, name, parent)| KsNotebook {
                id: id.clone(),
                name: name.clone(),
                parent_id: parent.clone(),
            })
            .collect())
    }

    fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
        self.ensure_cache()?;
        let cache = self.cache.lock().unwrap();
        Ok(cache.docs.values().map(|d| d.doc_ref.clone()).collect())
    }

    fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
        self.ensure_cache()?;
        let cache = self.cache.lock().unwrap();
        cache
            .docs
            .get(&doc.id)
            .map(|d| d.content.clone())
            .ok_or_else(|| format!("文档不在缓存: {}", doc.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;

    struct MapCaller {
        table: HashMap<String, serde_json::Value>,
    }

    impl MethodCaller for MapCaller {
        fn call(
            &self,
            _plugin_id: &str,
            _method: &str,
            args: serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            let rel = args.get("relPath").and_then(|v| v.as_str()).unwrap_or("");
            self.table
                .get(rel)
                .cloned()
                .ok_or_else(|| format!("无预设解析结果: {rel}"))
        }
    }

    fn write_file(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("建目录");
        }
        let mut file = std::fs::File::create(path).expect("建文件");
        file.write_all(content.as_bytes()).expect("写文件");
    }

    fn adapter_in(
        root: &std::path::Path,
        table: HashMap<String, serde_json::Value>,
    ) -> PluginLocalAdapter<MapCaller> {
        PluginLocalAdapter::new(
            "omni.test.local",
            "test",
            "ks",
            "import:ks",
            "test",
            "parseDocument",
            root.to_path_buf(),
            vec!["md".to_string()],
            MapCaller { table },
        )
    }

    #[test]
    fn walk_respects_patterns_and_skips_hidden() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_file(&dir.path().join("a.md"), "# A");
        write_file(&dir.path().join("b.txt"), "no");
        write_file(&dir.path().join(".hidden.md"), "no");
        write_file(&dir.path().join("sub").join("c.md"), "# C");
        let files = walk_local_files(dir.path(), &["md".to_string()]);
        let rels: Vec<_> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["a.md", "sub/c.md"]);
    }

    #[test]
    fn walk_reaches_siyuan_conf_but_not_other_dotdirs() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_file(
            &dir.path().join("box1").join(".siyuan").join("conf.json"),
            r#"{"name":"工作笔记"}"#,
        );
        write_file(&dir.path().join("box1").join("doc.sy"), "{}");
        write_file(&dir.path().join("box1").join(".git").join("x"), "no");
        let files = walk_local_files(
            dir.path(),
            &["sy".to_string(), ".siyuan/conf.json".to_string()],
        );
        let rels: Vec<_> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["box1/.siyuan/conf.json", "box1/doc.sy"]);
    }

    #[test]
    fn traversal_is_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_file(&dir.path().join("a.md"), "x");
        assert!(read_local_file(dir.path(), "../evil").is_err());
        assert!(read_local_file(dir.path(), "/abs").is_err());
        assert_eq!(read_local_file(dir.path(), "a.md").unwrap(), "x");
    }

    #[test]
    fn parse_flow_builds_notebooks_and_docs() {
        use serde_json::json;
        let dir = tempfile::tempdir().expect("临时目录");
        write_file(&dir.path().join("box1").join("a.md"), "# A");
        write_file(&dir.path().join("box1").join("b.md"), "# B");
        let mut table = HashMap::new();
        table.insert(
            "box1/a.md".to_string(),
            json!({ "kind": "doc", "id": "a", "title": "A", "markdown": "# A" }),
        );
        table.insert(
            "box1/b.md".to_string(),
            json!({ "kind": "doc", "id": "b", "title": "B", "markdown": "# B" }),
        );
        let adapter = adapter_in(dir.path(), table);
        let notebooks = adapter.list_notebooks().expect("列目录");
        assert_eq!(notebooks.len(), 1);
        assert_eq!(notebooks[0].id, "box1");
        let docs = adapter.list_documents().expect("列文档");
        assert_eq!(docs.len(), 2);
        let content = adapter.get_document(&docs[0]).expect("取文档");
        assert!(content.markdown.contains('#'));
        // id 映射走 ks 前缀。
        assert_eq!(adapter.doc_entry_id("a"), "ks-doc-a");
        assert_eq!(adapter.doc_source("box1", "a"), "import:ks:doc:box1/a");
    }

    #[test]
    fn explicit_notebook_name_wins() {
        use serde_json::json;
        let dir = tempfile::tempdir().expect("临时目录");
        write_file(&dir.path().join("box1").join("conf.json"), "{}");
        write_file(&dir.path().join("box1").join("a.md"), "x");
        let mut table = HashMap::new();
        table.insert(
            "box1/conf.json".to_string(),
            json!({ "kind": "notebook", "id": "box1", "name": "漂亮名字" }),
        );
        table.insert(
            "box1/a.md".to_string(),
            json!({ "kind": "doc", "id": "a", "title": "A", "markdown": "x" }),
        );
        // conf.json 也要能被扫描到：patterns 放空。
        let adapter = PluginLocalAdapter::new(
            "omni.test.local",
            "test",
            "ks",
            "import:ks",
            "test",
            "parseDocument",
            dir.path().to_path_buf(),
            vec![],
            MapCaller { table },
        );
        let notebooks = adapter.list_notebooks().expect("列目录");
        assert_eq!(notebooks.len(), 1);
        assert_eq!(notebooks[0].name, "漂亮名字");
    }

    #[test]
    fn empty_root_is_clear_error() {
        let dir = tempfile::tempdir().expect("临时目录");
        let adapter = adapter_in(dir.path(), HashMap::new());
        let err = adapter.list_notebooks().expect_err("空目录应报错");
        assert!(err.contains("未发现可同步文件"), "提示可读: {err}");
    }

    #[test]
    fn siyuan_compat_options_reproduce_legacy_ids() {
        let dir = tempfile::tempdir().expect("临时目录");
        let compat = PluginLocalAdapter::new(
            "omni.knowledge.siyuan",
            "siyuan",
            "siyuan",
            "import:siyuan",
            "siyuan",
            "parseDocument",
            dir.path().to_path_buf(),
            vec!["md".to_string()],
            MapCaller {
                table: HashMap::new(),
            },
        );
        assert_eq!(compat.doc_entry_id("a"), "siyuan-doc-a");
        assert_eq!(compat.folder_entry_id("box1"), "siyuan-box-box1");
        assert_eq!(compat.archive_folder_id("box1"), "siyuan-archive-box1");
        assert_eq!(compat.doc_source("box1", "a"), "import:siyuan:doc:box1/a");
        assert_eq!(compat.tag(), "siyuan");
        assert_eq!(compat.archive_tag(), "siyuan:archived");
        assert_eq!(
            compat.file_key(&crate::adapter::KsDocRef {
                id: "a".to_string(),
                title: String::new(),
                parent_id: None,
                box_id: "box1".to_string(),
                rel_path: "a.md".to_string(),
                fingerprint: "1".to_string(),
            }),
            "local:box1:a.md"
        );
    }
}
