//! 思源笔记镜像：`.sy` 块解析 + 本地/S3 数据源 + 知识库同步管线。
//!
//! - 只读镜像：读思源文件/S3，写知识库；**写回一律走思源内核 API**（本 crate 不写 `.sy`）。
//! - 数据源二选一：`Local`（工作空间 `data/` 目录，默认）/ `S3`（dejavu 读端，后置占位）。
//! - 持久化类型归 `omnipanel-store`（`siyuan_sync` 模块），本 crate 做解析与同步逻辑。

pub mod mapping;
pub mod scan;
pub mod sy;
pub mod sync;

pub use omnipanel_store::{SiyuanFileState, SiyuanSourceType, SiyuanSyncConfig};
pub use scan::{SiyuanDocFile, SiyuanNotebook};
pub use sy::{SyBlock, SyDoc, doc_markdown, doc_title, parse_sy_doc};
pub use sync::{
    S3_NOT_READY_MSG, SiyuanSyncFailure, SiyuanSyncReport, push_failure, sync_local, sync_rebuild,
};

/// 测试本地连接：返回（笔记本数，文档数）。目录非法直接 Err。
pub fn test_local_connection(data_dir: &std::path::Path) -> Result<(usize, usize), String> {
    if !data_dir.is_dir() {
        return Err(format!(
            "思源数据目录不存在或不可读: {}",
            data_dir.display()
        ));
    }
    let notebooks = scan::list_notebooks(data_dir);
    if notebooks.is_empty() {
        return Err(format!(
            "目录下未发现思源笔记本（需要工作空间的 data 目录）: {}",
            data_dir.display()
        ));
    }
    let docs = scan::scan_docs(data_dir)?;
    Ok((notebooks.len(), docs.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn write_file(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建目录");
        }
        let mut file = fs::File::create(path).expect("建文件");
        file.write_all(content.as_bytes()).expect("写文件");
    }

    /// 端到端：临时工作空间 → 同步入库 → 增量/归档语义。
    /// 注意文件名 stem 即文档 id（思源约定），与 JSON 内 id 一致。
    #[test]
    fn local_sync_end_to_end() {
        let dir = tempfile::tempdir().expect("临时目录");
        let data = dir.path().join("data");
        write_file(
            &data.join("boxA").join(".siyuan").join("conf.json"),
            r#"{"name":"工作笔记"}"#,
        );
        write_file(
            &data.join("boxA").join("doc1.sy"),
            r#"{"id":"doc1","type":"NodeDocument","content":"","ial":"{: title=\"日记\"}","children":[{"id":"b1","type":"NodeParagraph","content":"你好","markdown":"你好","children":[]}]}"#,
        );

        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = SiyuanSyncConfig {
            workspace_path: data.to_string_lossy().to_string(),
            ..Default::default()
        };

        // 首轮：全量新增。
        let report = sync_local(&storage, &cfg).expect("首轮同步");
        assert_eq!(report.scanned, 1);
        assert_eq!(report.added, 1);
        assert!(report.failed.is_empty());
        let entry = storage
            .get_knowledge("siyuan-doc-doc1")
            .expect("读条目")
            .expect("文档应入库");
        assert_eq!(entry.title, "日记");
        assert!(entry.content.contains("你好"));
        assert!(entry.tags.contains(&"siyuan".to_string()));
        assert_eq!(entry.parent_id, "siyuan-box-boxA");
        assert_eq!(entry.node_type, "document");
        let folder = storage
            .get_knowledge("siyuan-box-boxA")
            .expect("读文件夹")
            .expect("笔记本文件夹应入库");
        assert_eq!(folder.node_type, "folder");
        assert_eq!(folder.title, "工作笔记");

        // 二轮：无变化，零操作。
        let report2 = sync_local(&storage, &cfg).expect("二轮同步");
        assert_eq!(report2.added, 0);
        assert_eq!(report2.updated, 0);
        assert_eq!(report2.archived, 0);

        // 改文件：mtime 变化才触发更新（显式改 state 保证跨平台）。
        let doc_path = data.join("boxA").join("doc1.sy");
        write_file(
            &doc_path,
            r#"{"id":"doc1","type":"NodeDocument","content":"","ial":"{: title=\"日记\"}","children":[{"id":"b1","type":"NodeParagraph","content":"你好世界","markdown":"你好世界","children":[]}]}"#,
        );
        let states = storage.siyuan_file_state_list().expect("读状态");
        assert_eq!(states.len(), 1);
        let mut stale = states[0].clone();
        stale.mtime_ms = 0;
        storage.siyuan_file_state_upsert(&stale).expect("置旧");
        let report3 = sync_local(&storage, &cfg).expect("三轮同步");
        assert_eq!(report3.updated, 1);
        let entry3 = storage
            .get_knowledge("siyuan-doc-doc1")
            .expect("读条目")
            .expect("文档应在库");
        assert!(entry3.content.contains("你好世界"));
        // 更新自动推历史版本。
        let revisions = storage
            .list_knowledge_revisions("siyuan-doc-doc1")
            .expect("读历史");
        assert!(!revisions.is_empty(), "更新应留历史版本");

        // 删文件：归档而非硬删。
        fs::remove_file(&doc_path).expect("删文件");
        let report4 = sync_local(&storage, &cfg).expect("四轮同步");
        assert_eq!(report4.archived, 1);
        let archived = storage
            .get_knowledge("siyuan-doc-doc1")
            .expect("读条目")
            .expect("归档条目仍在库");
        assert_eq!(archived.parent_id, "siyuan-archive-boxA");
        assert!(archived.tags.contains(&"siyuan:archived".to_string()));
    }

    #[test]
    fn broken_doc_does_not_abort_batch() {
        let dir = tempfile::tempdir().expect("临时目录");
        let data = dir.path().join("data");
        write_file(
            &data.join("boxA").join(".siyuan").join("conf.json"),
            r#"{"name":"boxA"}"#,
        );
        write_file(&data.join("boxA").join("bad.sy"), "{oops");
        write_file(
            &data.join("boxA").join("good.sy"),
            r#"{"id":"g","type":"NodeDocument","children":[]}"#,
        );
        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = SiyuanSyncConfig {
            workspace_path: data.to_string_lossy().to_string(),
            ..Default::default()
        };
        let report = sync_local(&storage, &cfg).expect("整批不炸");
        assert_eq!(report.added, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].file_key.contains("bad.sy"));
    }

    /// 整盒删除后重同步：文件夹重建，文档自动恢复（删坏重试自愈）。
    #[test]
    fn box_delete_heals_on_next_sync() {
        let dir = tempfile::tempdir().expect("临时目录");
        let data = dir.path().join("data");
        write_file(
            &data.join("boxA").join(".siyuan").join("conf.json"),
            r#"{"name":"boxA"}"#,
        );
        write_file(
            &data.join("boxA").join("doc1.sy"),
            r#"{"ID":"doc1","Type":"NodeDocument","Properties":{"title":"t"},"Children":[]}"#,
        );
        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = SiyuanSyncConfig {
            workspace_path: data.to_string_lossy().to_string(),
            ..Default::default()
        };
        let report = sync_local(&storage, &cfg).expect("首轮");
        assert_eq!(report.added, 1);

        // 模拟用户删坏：整盒条目全删，状态保留。
        storage.delete_knowledge("siyuan-doc-doc1").expect("删文档");
        storage.delete_knowledge("siyuan-box-boxA").expect("删盒子");
        assert!(
            storage
                .get_knowledge("siyuan-doc-doc1")
                .expect("读")
                .is_none()
        );

        let report2 = sync_local(&storage, &cfg).expect("次轮自愈");
        assert_eq!(report2.updated, 1, "盒子重建应带回文档");
        assert!(
            storage
                .get_knowledge("siyuan-doc-doc1")
                .expect("读")
                .is_some()
        );
    }

    /// 单文档手删仍被尊重：盒子还在时不复活。
    #[test]
    fn single_doc_delete_is_respected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let data = dir.path().join("data");
        write_file(
            &data.join("boxA").join(".siyuan").join("conf.json"),
            r#"{"name":"boxA"}"#,
        );
        write_file(
            &data.join("boxA").join("doc1.sy"),
            r#"{"ID":"doc1","Type":"NodeDocument","Properties":{"title":"t"},"Children":[]}"#,
        );
        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = SiyuanSyncConfig {
            workspace_path: data.to_string_lossy().to_string(),
            ..Default::default()
        };
        sync_local(&storage, &cfg).expect("首轮");
        storage
            .delete_knowledge("siyuan-doc-doc1")
            .expect("手删文档");
        let report2 = sync_local(&storage, &cfg).expect("次轮");
        assert_eq!(report2.added + report2.updated, 0, "手删不复活");
        assert!(
            storage
                .get_knowledge("siyuan-doc-doc1")
                .expect("读")
                .is_none()
        );
    }

    /// 重建同步：状态漂移后全量回填，不产生重复。
    #[test]
    fn rebuild_restores_everything() {
        let dir = tempfile::tempdir().expect("临时目录");
        let data = dir.path().join("data");
        write_file(
            &data.join("boxA").join(".siyuan").join("conf.json"),
            r#"{"name":"boxA"}"#,
        );
        write_file(
            &data.join("boxA").join("doc1.sy"),
            r#"{"ID":"doc1","Type":"NodeDocument","Properties":{"title":"t"},"Children":[]}"#,
        );
        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = SiyuanSyncConfig {
            workspace_path: data.to_string_lossy().to_string(),
            ..Default::default()
        };
        sync_local(&storage, &cfg).expect("首轮");
        // 模拟状态漂移：文档丢了但状态还在。
        storage.delete_knowledge("siyuan-doc-doc1").expect("丢文档");
        let report = sync_rebuild(&storage, &cfg).expect("重建");
        assert_eq!(report.added, 1);
        assert!(
            storage
                .get_knowledge("siyuan-doc-doc1")
                .expect("读")
                .is_some()
        );
        let states = storage.siyuan_file_state_list().expect("读状态");
        assert_eq!(states.len(), 1);
    }
}
