//! 思源对象 → [`KnowledgeEntry`] 映射。
//!
//! 约定：
//! - 笔记本 → `node_type=folder` 文件夹，文档挂在其下；删除的文档归档到同笔记本的
//!   `已归档` 文件夹（`parent_id` 迁移），不硬删，保证可恢复。
//! - 条目 id 稳定可推导（`siyuan-box-<box>` / `siyuan-doc-<doc>`），重复同步天然幂等。
//! - `kind` 用 `"note"`（知识库 kind 自由取值，列表/FTS 只在显式过滤时约束）。
//! - `tags` 必含 `"siyuan"`；更新时保留用户自加标签，只维护思源侧字段。

use omnipanel_store::KnowledgeEntry;

use crate::scan::{SiyuanDocFile, SiyuanNotebook};
use crate::sy::{doc_markdown, doc_title};

pub const SIYUAN_TAG: &str = "siyuan";
pub const SIYUAN_ARCHIVED_TAG: &str = "siyuan:archived";

pub fn box_folder_id(box_id: &str) -> String {
    format!("siyuan-box-{box_id}")
}

pub fn archive_folder_id(box_id: &str) -> String {
    format!("siyuan-archive-{box_id}")
}

pub fn doc_entry_id(doc_id: &str) -> String {
    format!("siyuan-doc-{doc_id}")
}

pub fn box_source(box_id: &str) -> String {
    // `import:` 前缀：知识库按此前缀划分"导入"区（对齐 PDF 导入 `import:pdf:`）。
    format!("import:siyuan:box:{box_id}")
}

pub fn doc_source(box_id: &str, doc_id: &str) -> String {
    format!("import:siyuan:doc:{box_id}/{doc_id}")
}

fn base_entry(
    id: String,
    title: String,
    node_type: &str,
    parent_id: &str,
    now_ms: i64,
) -> KnowledgeEntry {
    KnowledgeEntry {
        id,
        kind: "note".to_string(),
        title,
        content: String::new(),
        tags: vec![SIYUAN_TAG.to_string()],
        risk_level: "safe".to_string(),
        source: String::new(),
        env_tag: "dev".to_string(),
        language: String::new(),
        usage_count: 0,
        created_at: now_ms,
        updated_at: now_ms,
        parent_id: parent_id.to_string(),
        node_type: node_type.to_string(),
        sort_order: 0,
        resource_type: String::new(),
        resource_id: String::new(),
    }
}

/// 笔记本文件夹条目。
pub fn box_folder_entry(notebook: &SiyuanNotebook, now_ms: i64) -> KnowledgeEntry {
    let mut entry = base_entry(
        box_folder_id(&notebook.id),
        notebook.name.clone(),
        "folder",
        "",
        now_ms,
    );
    entry.source = box_source(&notebook.id);
    entry
}

/// 笔记本的 `已归档` 文件夹条目（懒创建：首次归档时才落库）。
pub fn archive_folder_entry(box_id: &str, box_name: &str, now_ms: i64) -> KnowledgeEntry {
    let mut entry = base_entry(
        archive_folder_id(box_id),
        format!("{box_name} · 已归档"),
        "folder",
        &box_folder_id(box_id),
        now_ms,
    );
    entry.source = format!("import:siyuan:archive:{box_id}");
    entry.tags.push(SIYUAN_ARCHIVED_TAG.to_string());
    entry
}

/// 文档条目（新建用）。更新路径见 [`refresh_doc_entry`]（保留用户标签）。
pub fn new_doc_entry(
    file: &SiyuanDocFile,
    title: String,
    markdown: String,
    parent_folder_id: &str,
    now_ms: i64,
) -> KnowledgeEntry {
    let mut entry = base_entry(
        doc_entry_id(&file.doc_id),
        title,
        "document",
        parent_folder_id,
        now_ms,
    );
    entry.content = markdown;
    entry.source = doc_source(&file.box_id, &file.doc_id);
    entry
}

/// 用新解析结果刷新既有条目：只动标题/正文/source/时间，保留用户自加标签；
/// 去掉归档标签（对端仍在即视为复活，回盒子下）。
pub fn refresh_doc_entry(
    mut existing: KnowledgeEntry,
    file: &SiyuanDocFile,
    title: String,
    markdown: String,
    parent_folder_id: &str,
    now_ms: i64,
) -> KnowledgeEntry {
    existing.title = title;
    existing.content = markdown;
    existing.source = doc_source(&file.box_id, &file.doc_id);
    existing.parent_id = parent_folder_id.to_string();
    existing.updated_at = now_ms;
    existing.tags.retain(|tag| tag != SIYUAN_ARCHIVED_TAG);
    if !existing.tags.iter().any(|tag| tag == SIYUAN_TAG) {
        existing.tags.push(SIYUAN_TAG.to_string());
    }
    existing
}

/// 归档条目：迁入归档文件夹 + 打归档标签（内容与历史版本保留）。
pub fn archive_doc_entry(
    mut existing: KnowledgeEntry,
    box_id: &str,
    now_ms: i64,
) -> KnowledgeEntry {
    existing.parent_id = archive_folder_id(box_id);
    existing.updated_at = now_ms;
    if !existing.tags.iter().any(|tag| tag == SIYUAN_ARCHIVED_TAG) {
        existing.tags.push(SIYUAN_ARCHIVED_TAG.to_string());
    }
    existing
}

/// 从 `.sy` 正文产出（标题， Markdown）。文件名 stem 作标题兜底。
pub fn render_doc(file: &SiyuanDocFile, sy_text: &str) -> Result<(String, String), String> {
    let doc = crate::sy::parse_sy_doc(sy_text)?;
    let title = doc_title(&doc, &file.doc_id);
    let markdown = doc_markdown(&doc);
    Ok((title, markdown))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_sources_are_stable() {
        assert_eq!(box_folder_id("b1"), "siyuan-box-b1");
        assert_eq!(doc_entry_id("d1"), "siyuan-doc-d1");
        assert_eq!(doc_source("b1", "d1"), "import:siyuan:doc:b1/d1");
    }

    #[test]
    fn refresh_keeps_user_tags() {
        let mut existing = base_entry("siyuan-doc-d1".into(), "旧".into(), "document", "p", 1);
        existing.tags.push("我的标签".into());
        let file = SiyuanDocFile {
            box_id: "b1".into(),
            rel_path: "d1.sy".into(),
            abs_path: std::path::PathBuf::from("d1.sy"),
            doc_id: "d1".into(),
            mtime_ms: 2,
        };
        let next = refresh_doc_entry(existing, &file, "新".into(), "正文".into(), "p2", 3);
        assert_eq!(next.title, "新");
        assert!(next.tags.contains(&"siyuan".to_string()));
        assert!(next.tags.contains(&"我的标签".to_string()));
        assert_eq!(next.parent_id, "p2");
    }
}
