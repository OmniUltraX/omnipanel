//! 思源原生适配器：把本地工作空间接到通用同步引擎。
//!
//! id/标签/source 全部沿用旧格式（`siyuan-doc-*` / `import:siyuan:*`），
//! 存量条目与迁移后的状态行字节一致，不触发重同步风暴。

use std::path::{Path, PathBuf};

use omnipanel_knowledge_source::{KsDocContent, KsDocRef, KsNotebook, SourceAdapter};

use crate::mapping;
use crate::scan;

/// 思源本地适配器（工作空间 `data/` 目录）。
pub struct SiyuanAdapter {
    data_dir: PathBuf,
}

impl SiyuanAdapter {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

impl SourceAdapter for SiyuanAdapter {
    fn namespace(&self) -> &str {
        "siyuan"
    }

    fn adapter_kind(&self) -> &'static str {
        "siyuan-local"
    }

    fn source_key(&self) -> String {
        "siyuan".to_string()
    }

    fn folder_entry_id(&self, box_id: &str) -> String {
        mapping::box_folder_id(box_id)
    }

    fn doc_entry_id(&self, doc_id: &str) -> String {
        mapping::doc_entry_id(doc_id)
    }

    fn archive_folder_id(&self, box_id: &str) -> String {
        mapping::archive_folder_id(box_id)
    }

    fn folder_source(&self, box_id: &str) -> String {
        mapping::box_source(box_id)
    }

    fn doc_source(&self, box_id: &str, doc_id: &str) -> String {
        mapping::doc_source(box_id, doc_id)
    }

    fn archive_source(&self, box_id: &str) -> String {
        format!("import:siyuan:archive:{box_id}")
    }

    fn tag(&self) -> String {
        mapping::SIYUAN_TAG.to_string()
    }

    fn archive_tag(&self) -> String {
        mapping::SIYUAN_ARCHIVED_TAG.to_string()
    }

    fn file_key(&self, doc: &KsDocRef) -> String {
        format!("local:{}:{}", doc.box_id, doc.rel_path)
    }

    fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
        Ok(scan::list_notebooks(&self.data_dir)
            .into_iter()
            .map(|nb| KsNotebook {
                id: nb.id,
                name: nb.name,
                parent_id: None,
            })
            .collect())
    }

    fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
        Ok(scan::scan_docs(&self.data_dir)?
            .into_iter()
            .map(|file| KsDocRef {
                id: file.doc_id.clone(),
                title: String::new(),
                parent_id: None,
                box_id: file.box_id.clone(),
                rel_path: file.rel_path.clone(),
                fingerprint: file.mtime_ms.to_string(),
            })
            .collect())
    }

    fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
        use crate::scan::SiyuanDocFile;
        // rel_path 即盒子内相对路径，直接拼接免二次全量扫描。
        let abs_path = self.data_dir.join(&doc.box_id).join(&doc.rel_path);
        let text = std::fs::read_to_string(&abs_path)
            .map_err(|e| format!("读取 {} 失败: {e}", doc.rel_path))?;
        let file = SiyuanDocFile {
            box_id: doc.box_id.clone(),
            rel_path: doc.rel_path.clone(),
            abs_path,
            doc_id: doc.id.clone(),
            mtime_ms: 0,
        };
        let (title, markdown) = mapping::render_doc(&file, &text)?;
        Ok(KsDocContent {
            title,
            markdown,
            updated_at_ms: None,
        })
    }
}
