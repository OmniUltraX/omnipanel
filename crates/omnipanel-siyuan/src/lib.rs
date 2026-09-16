//! 思源笔记镜像：`.sy` 块解析 + 本地工作空间扫描 + 通用同步引擎之上的原生适配器。
//!
//! - 只读镜像：读思源文件，写知识库；**写回一律走思源内核 API**（本 crate 不写 `.sy`）。
//! - 同步语义由 [`omnipanel_knowledge_source`] 引擎实现，本 crate 只提供
//!   `SiyuanAdapter`（扫描/解析/映射，id 与 source 沿用旧格式）。

pub mod adapter;
pub mod mapping;
pub mod scan;
pub mod sy;

pub use adapter::SiyuanAdapter;
pub use omnipanel_knowledge_source::{
    KsFailure as SiyuanSyncFailure, KsReport as SiyuanSyncReport,
};
pub use omnipanel_store::{SiyuanFileState, SiyuanSourceType, SiyuanSyncConfig};
pub use scan::{SiyuanDocFile, SiyuanNotebook};
pub use sy::{SyBlock, SyDoc, doc_markdown, doc_title, parse_sy_doc};

use omnipanel_error::{OmniError, OmniResult};

/// S3 同步尚未实现时的统一错误（配置可存，执行拒绝）。
pub const S3_NOT_READY_MSG: &str = "S3 数据源尚未实现（dejavu 读端开发中），请先使用本地目录数据源";

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

fn adapter_of(cfg: &SiyuanSyncConfig) -> Result<SiyuanAdapter, OmniError> {
    cfg.validate().map_err(OmniError::invalid_input)?;
    match cfg.source_type {
        SiyuanSourceType::S3 => Err(OmniError::invalid_input(S3_NOT_READY_MSG)),
        SiyuanSourceType::Local => Ok(SiyuanAdapter::new(cfg.workspace_path.trim())),
    }
}

/// Local 数据源一次全量比对同步（经通用引擎；报告同时回写旧配置表以兼容对话框）。
pub fn sync_local(
    storage: &omnipanel_store::Storage,
    cfg: &SiyuanSyncConfig,
) -> OmniResult<SiyuanSyncReport> {
    let adapter = adapter_of(cfg)?;
    let report = omnipanel_knowledge_source::sync_source(storage, &adapter, "思源笔记")?;
    mirror_report_to_legacy(storage, &report)?;
    Ok(report)
}

/// 重建同步：清空文件状态后全量重评。
pub fn sync_rebuild(
    storage: &omnipanel_store::Storage,
    cfg: &SiyuanSyncConfig,
) -> OmniResult<SiyuanSyncReport> {
    let adapter = adapter_of(cfg)?;
    let report = omnipanel_knowledge_source::rebuild_source(storage, &adapter, "思源笔记")?;
    mirror_report_to_legacy(storage, &report)?;
    Ok(report)
}

/// 旧配置表（`siyuan_sync_config`）的状态页读这里：同步报告回填，保持对话框兼容。
fn mirror_report_to_legacy(
    storage: &omnipanel_store::Storage,
    report: &SiyuanSyncReport,
) -> OmniResult<()> {
    let mut cfg = storage.siyuan_config_get()?;
    cfg.last_sync_at = report.finished_at_ms;
    cfg.last_report_json = serde_json::to_string(report).unwrap_or_default();
    storage.siyuan_config_save(&cfg)
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

    fn local_cfg(data: &std::path::Path) -> SiyuanSyncConfig {
        SiyuanSyncConfig {
            workspace_path: data.to_string_lossy().to_string(),
            ..Default::default()
        }
    }

    /// 端到端：临时工作空间 → 同步入库 → 增量/归档语义（经通用引擎）。
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
            r#"{"ID":"doc1","Type":"NodeDocument","Properties":{"title":"日记"},"Children":[{"ID":"b1","Type":"NodeParagraph","Children":[{"Type":"NodeText","Data":"你好"}]}]}"#,
        );

        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = local_cfg(&data);

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
        // 旧配置表同步回填（对话框状态页）。
        let legacy = storage.siyuan_config_get().expect("读旧配置");
        assert!(legacy.last_sync_at > 0);

        // 二轮：无变化，零操作。
        let report2 = sync_local(&storage, &cfg).expect("二轮同步");
        assert_eq!(report2.added, 0);
        assert_eq!(report2.updated, 0);
        assert_eq!(report2.archived, 0);

        // 改mtime指纹 → 更新。
        let states = storage.ks_file_state_list("siyuan").expect("读状态");
        assert_eq!(states.len(), 1);
        let mut stale = states[0].clone();
        stale.fingerprint = "0".to_string();
        storage.ks_file_state_upsert(&stale).expect("置旧");
        // 内容也要变，否则 refresh 写回相同内容（updated 照计，符合语义）。
        write_file(
            &data.join("boxA").join("doc1.sy"),
            r#"{"ID":"doc1","Type":"NodeDocument","Properties":{"title":"日记"},"Children":[{"ID":"b1","Type":"NodeParagraph","Children":[{"Type":"NodeText","Data":"你好世界"}]}]}"#,
        );
        let report3 = sync_local(&storage, &cfg).expect("三轮同步");
        assert_eq!(report3.updated, 1);
        let entry3 = storage
            .get_knowledge("siyuan-doc-doc1")
            .expect("读条目")
            .expect("文档应在库");
        assert!(entry3.content.contains("你好世界"));
        let revisions = storage
            .list_knowledge_revisions("siyuan-doc-doc1")
            .expect("读历史");
        assert!(!revisions.is_empty(), "更新应留历史版本");

        // 删文件：归档而非硬删。
        fs::remove_file(data.join("boxA").join("doc1.sy")).expect("删文件");
        let report4 = sync_local(&storage, &cfg).expect("四轮同步");
        assert_eq!(report4.archived, 1);
        let archived = storage
            .get_knowledge("siyuan-doc-doc1")
            .expect("读条目")
            .expect("归档条目仍在库");
        assert_eq!(archived.parent_id, "siyuan-archive-boxA");
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
            r#"{"ID":"good","Type":"NodeDocument","Properties":{"title":"g"},"Children":[]}"#,
        );
        let storage = omnipanel_store::Storage::open_in_memory().expect("内存库");
        let cfg = local_cfg(&data);
        let report = sync_local(&storage, &cfg).expect("整批不炸");
        assert_eq!(report.added, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].file_key.contains("bad.sy"));
    }

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
        let cfg = local_cfg(&data);
        let report = sync_local(&storage, &cfg).expect("首轮");
        assert_eq!(report.added, 1);

        storage.delete_knowledge("siyuan-doc-doc1").expect("删文档");
        storage.delete_knowledge("siyuan-box-boxA").expect("删盒子");

        let report2 = sync_local(&storage, &cfg).expect("次轮自愈");
        assert_eq!(report2.updated, 1);
        assert!(
            storage
                .get_knowledge("siyuan-doc-doc1")
                .expect("读")
                .is_some()
        );
    }

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
        let cfg = local_cfg(&data);
        sync_local(&storage, &cfg).expect("首轮");
        storage.delete_knowledge("siyuan-doc-doc1").expect("手删");
        let report2 = sync_local(&storage, &cfg).expect("次轮");
        assert_eq!(report2.added + report2.updated, 0);
    }

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
        let cfg = local_cfg(&data);
        sync_local(&storage, &cfg).expect("首轮");
        storage.delete_knowledge("siyuan-doc-doc1").expect("丢文档");
        let report = sync_rebuild(&storage, &cfg).expect("重建");
        assert_eq!(report.added, 1);
        assert!(
            storage
                .get_knowledge("siyuan-doc-doc1")
                .expect("读")
                .is_some()
        );
    }
}
