//! 思源工作空间（`data/` 目录）扫描：笔记本列表 + `.sy` 文档清单。
//!
//! 排除规则对齐思源自身的同步忽略（`kernel/model/sync_path.go` 读取结论）：
//! 点开头目录/文件、`*.tmp`、
//! `storage/local.json`、`storage/recent-doc.json`、`storage/ref-used.json`、
//! `filesys_status_check`，以及笔记本级的 `assets`/`templates`/`widgets`/`emojis`/`storage`。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 思源笔记本（`data/` 下一级子目录）。
#[derive(Debug, Clone)]
pub struct SiyuanNotebook {
    pub id: String,
    pub name: String,
}

/// 待同步的单个 `.sy` 文档文件。
#[derive(Debug, Clone)]
pub struct SiyuanDocFile {
    pub box_id: String,
    /// 笔记本内相对路径（`/` 分隔），如 `20240101-xxxx/20240102-yyyy.sy`。
    pub rel_path: String,
    pub abs_path: PathBuf,
    /// 文档 id（文件名 stem）。
    pub doc_id: String,
    pub mtime_ms: i64,
}

/// 笔记本目录不参与文档扫描的子目录。
const NOTEBOOK_SKIP_DIRS: &[&str] = &[
    "assets",
    "templates",
    "widgets",
    "emojis",
    "storage",
    "filesys_status_check",
];

/// 顶层非笔记本目录（用户指南之类也照同步思源官方行为：子目录即笔记本）。
/// 这里只排除明确的系统目录；最终再以 `.siyuan/conf.json` 是否存在判定。
const DATA_SKIP_DIRS: &[&str] = &[
    "storage",
    "filesys_status_check",
    "templates",
    "widgets",
    "emojis",
    "assets",
    "plugins",
    "public",
];

const STORAGE_SKIP_FILES: &[&str] = &["local.json", "recent-doc.json", "ref-used.json"];

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// 笔记本判定：含 `.siyuan/conf.json` 的顶层目录才是笔记本。
/// 线上工作空间实测：全部真实笔记本都有 conf.json，
/// `assets`/`plugins`/`public` 等系统目录都没有。
fn is_notebook_dir(dir: &Path) -> bool {
    dir.join(".siyuan").join("conf.json").is_file()
}

/// 尝试读取笔记本显示名（`<box>/.siyuan/conf.json` 的 `name` 字段），失败回退 box id。
fn notebook_name(box_dir: &Path, box_id: &str) -> String {
    let conf_path = box_dir.join(".siyuan").join("conf.json");
    if let Ok(text) = fs::read_to_string(&conf_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(name) = value.get("name").and_then(|v| v.as_str()) {
                let name = name.trim();
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    box_id.to_string()
}

/// 列出工作空间 `data/` 下的笔记本。`data_dir` 不存在或不可读返回空列表（调用方判空提示）。
pub fn list_notebooks(data_dir: &Path) -> Vec<SiyuanNotebook> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(data_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) || DATA_SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if !is_notebook_dir(&entry.path()) {
            continue;
        }
        out.push(SiyuanNotebook {
            id: name.clone(),
            name: notebook_name(&entry.path(), &name),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    out
}

fn file_mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn walk_sy_files(box_dir: &Path, rel_dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(box_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if NOTEBOOK_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_sy_files(&entry.path(), &rel_dir.join(&name), out);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if !name.ends_with(".sy") || name.ends_with(".tmp") {
            continue;
        }
        // storage 目录整体已跳过；这里只防 storage 下三个本地状态文件（相对路径兜底）。
        let rel = rel_dir.join(&name);
        let rel_slash = rel.to_string_lossy().replace('\\', "/");
        if rel_slash.starts_with("storage/")
            && STORAGE_SKIP_FILES
                .iter()
                .any(|skip| rel_slash == format!("storage/{skip}"))
        {
            continue;
        }
        out.push((rel_slash, entry.path()));
    }
}

/// 扫描全部 `.sy` 文档。`data_dir` 即工作空间的 `data/` 目录。
pub fn scan_docs(data_dir: &Path) -> Result<Vec<SiyuanDocFile>, String> {
    if !data_dir.is_dir() {
        return Err(format!(
            "思源数据目录不存在或不可读: {}",
            data_dir.display()
        ));
    }
    let mut out = Vec::new();
    for notebook in list_notebooks(data_dir) {
        let box_dir = data_dir.join(&notebook.id);
        let mut files = Vec::new();
        walk_sy_files(&box_dir, Path::new(""), &mut files);
        for (rel_path, abs_path) in files {
            let doc_id = Path::new(&rel_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if doc_id.is_empty() {
                continue;
            }
            out.push(SiyuanDocFile {
                box_id: notebook.id.clone(),
                rel_path,
                mtime_ms: file_mtime_ms(&abs_path),
                abs_path,
                doc_id,
            });
        }
    }
    out.sort_by(|a, b| a.box_id.cmp(&b.box_id).then(a.rel_path.cmp(&b.rel_path)));
    Ok(out)
}

/// 当前时间的毫秒时间戳（同步报告用）。
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建目录");
        }
        let mut file = fs::File::create(path).expect("建文件");
        file.write_all(content.as_bytes()).expect("写文件");
    }

    fn sample_workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("临时目录");
        let data = dir.path().join("data");
        // 笔记本 A：含嵌套文档 + 应排除的 assets/storage
        write_file(
            &data.join("boxA").join(".siyuan").join("conf.json"),
            r#"{"name":"工作笔记"}"#,
        );
        write_file(
            &data.join("boxA").join("doc1.sy"),
            r#"{"id":"d1","type":"NodeDocument","children":[]}"#,
        );
        write_file(
            &data.join("boxA").join("sub").join("doc2.sy"),
            r#"{"id":"d2","type":"NodeDocument","children":[]}"#,
        );
        write_file(&data.join("boxA").join("assets").join("a.png"), "bin");
        write_file(&data.join("boxA").join("storage").join("local.json"), "{}");
        write_file(&data.join("boxA").join(".hidden.sy"), "{}");
        // 笔记本 B：有 conf.json 但无 name，名回退 id
        write_file(
            &data.join("boxB").join(".siyuan").join("conf.json"),
            r#"{"sort":1}"#,
        );
        write_file(
            &data.join("boxB").join("doc3.sy"),
            r#"{"id":"d3","type":"NodeDocument","children":[]}"#,
        );
        // 顶层 storage 不视为笔记本
        write_file(&data.join("storage").join("recent-doc.json"), "{}");
        // 无 conf.json 的顶层目录（assets/plugins 类系统目录）不是笔记本
        write_file(
            &data.join("plugins").join("stray.sy"),
            r#"{"id":"s","type":"NodeDocument","children":[]}"#,
        );
        dir
    }

    #[test]
    fn notebooks_and_docs_scan_with_exclusions() {
        let dir = sample_workspace();
        let data = dir.path().join("data");
        let notebooks = list_notebooks(&data);
        assert_eq!(notebooks.len(), 2);
        // 按名称字节序：boxB 在中文名前
        assert_eq!(notebooks[0].id, "boxB");
        assert_eq!(notebooks[0].name, "boxB");
        assert_eq!(notebooks[1].name, "工作笔记");

        let docs = scan_docs(&data).expect("扫描应成功");
        let rels: Vec<_> = docs.iter().map(|d| d.rel_path.as_str()).collect();
        // 文档按 (box_id, rel_path) 排：boxA 在前（笔记本按名称排，两者维度不同）。
        assert_eq!(rels, vec!["doc1.sy", "sub/doc2.sy", "doc3.sy"]);
        assert!(docs.iter().all(|d| d.mtime_ms > 0));
        assert_eq!(docs[0].box_id, "boxA");
        assert_eq!(docs[2].doc_id, "doc3");
    }

    #[test]
    fn missing_data_dir_is_empty_or_error() {
        let missing = Path::new("/definitely/not/here/data-omnipanel-test");
        assert!(list_notebooks(missing).is_empty());
        assert!(scan_docs(missing).is_err());
    }
}
