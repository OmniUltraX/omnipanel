//! 知识源同步引擎（宿主侧）：适配器供数，引擎负责比对、落库、归档、报告。
//!
//! 语义（与思源原生实现一致，故意保守）：
//! - 单文档失败记入报告，不中断整批；
//! - 对端删除 → 本侧**归档**（迁入 `已归档` 文件夹 + 标签），不硬删；
//! - 用户在知识库侧手动删了镜像文档：指纹未变则**不再复活**，指纹变了视为更新；
//! - 盒子本轮重建 + 条目缺失 → 无视旧状态强制恢复（删坏重试自愈）；
//! - 更新保留用户自加标签，只刷新标题/正文/source/归属，并去掉归档标签。

use std::collections::{HashMap, HashSet};

use omnipanel_error::{OmniError, OmniResult};
use omnipanel_store::{KnowledgeEntry, Storage};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::adapter::{KsDocContent, KsDocRef, SourceAdapter};
use crate::now_millis;

/// 单文件失败明细。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsFailure {
    pub file_key: String,
    pub message: String,
}

/// 一次同步的报告（存 `ks_source_config.last_report_json`，状态页展示）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsReport {
    pub scanned: i64,
    pub added: i64,
    pub updated: i64,
    pub archived: i64,
    pub failed: Vec<KsFailure>,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

fn base_entry(
    id: String,
    title: String,
    node_type: &str,
    parent_id: &str,
    tags: Vec<String>,
    source: String,
    now_ms: i64,
) -> KnowledgeEntry {
    KnowledgeEntry {
        id,
        kind: "note".to_string(),
        title,
        content: String::new(),
        tags,
        risk_level: "safe".to_string(),
        source,
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

fn next_sort_order(storage: &Storage, parent_id: &str) -> OmniResult<i64> {
    let entries = storage.list_knowledge(None, None)?;
    Ok(entries
        .iter()
        .filter(|e| e.parent_id == parent_id)
        .map(|e| e.sort_order)
        .max()
        .unwrap_or(-1)
        + 1)
}

fn ensure_tag(tags: &mut Vec<String>, tag: &str) {
    if !tags.iter().any(|t| t == tag) {
        tags.push(tag.to_string());
    }
}

/// 全量比对同步。调用方负责配置校验与 S3 等不可用分支的前置拒绝。
pub fn sync_source<A: SourceAdapter>(
    storage: &Storage,
    adapter: &A,
    display_name: &str,
) -> OmniResult<KsReport> {
    let started_at_ms = now_millis();
    let mut report = KsReport {
        started_at_ms,
        ..Default::default()
    };
    let source_key = adapter.source_key();
    let tag = adapter.tag();
    let archive_tag = adapter.archive_tag();

    let notebooks = adapter.list_notebooks().map_err(OmniError::internal)?;
    if notebooks.is_empty() {
        return Err(OmniError::invalid_input(
            "数据源未返回任何笔记本/目录".to_string(),
        ));
    }
    // 笔记本 id → 文件夹条目 id（嵌套笔记本挂父文件夹下）。
    let folder_ids: HashMap<&str, String> = notebooks
        .iter()
        .map(|nb| (nb.id.as_str(), adapter.folder_entry_id(&nb.id)))
        .collect();

    // 笔记本文件夹：缺建，有则刷新标题。
    let mut recreated_boxes: HashSet<String> = HashSet::new();
    for notebook in &notebooks {
        let folder_id = &folder_ids[notebook.id.as_str()];
        let parent_folder_id = notebook
            .parent_id
            .as_deref()
            .and_then(|pid| folder_ids.get(pid))
            .cloned()
            .unwrap_or_default();
        match storage.get_knowledge(folder_id)? {
            None => {
                let mut entry = base_entry(
                    folder_id.clone(),
                    notebook.name.clone(),
                    "folder",
                    &parent_folder_id,
                    vec![tag.clone()],
                    adapter.folder_source(&notebook.id),
                    started_at_ms,
                );
                entry.sort_order = next_sort_order(storage, &parent_folder_id)?;
                storage.save_knowledge(&entry)?;
                recreated_boxes.insert(notebook.id.clone());
            }
            Some(mut existing) => {
                if existing.title != notebook.name {
                    existing.title = notebook.name.clone();
                    existing.updated_at = started_at_ms;
                    storage.save_knowledge(&existing)?;
                }
            }
        }
    }

    let docs = adapter.list_documents().map_err(OmniError::internal)?;
    report.scanned = docs.len() as i64;

    // 同盒文档 id → 条目 id（嵌套归属用；parent_id 优先，其次 rel 路径父目录推导）。
    let doc_entry_ids: HashMap<(&str, &str), String> = docs
        .iter()
        .map(|d| {
            (
                (d.box_id.as_str(), d.id.as_str()),
                adapter.doc_entry_id(&d.id),
            )
        })
        .collect();
    let resolve_parent = |adapter: &A, doc: &KsDocRef| -> String {
        if let Some(pid) = doc.parent_id.as_deref() {
            if let Some(fid) = folder_ids.get(pid) {
                return fid.clone();
            }
            if let Some(eid) = doc_entry_ids.get(&(doc.box_id.as_str(), pid)) {
                let own = adapter.doc_entry_id(&doc.id);
                if *eid != own {
                    return eid.clone();
                }
            }
        }
        // rel 路径父目录名与同盒文档 id 相同 → 视为子文档（思源子目录即父文档 id）。
        if let Some(slash) = doc.rel_path.rfind('/') {
            let dir = &doc.rel_path[..slash];
            if let Some(name) = dir.rsplit('/').next() {
                if !name.is_empty() {
                    if let Some(eid) = doc_entry_ids.get(&(doc.box_id.as_str(), name)) {
                        let own = adapter.doc_entry_id(&doc.id);
                        if *eid != own {
                            return eid.clone();
                        }
                    }
                }
            }
        }
        adapter.folder_entry_id(&doc.box_id)
    };

    let states = storage.ks_file_state_list(&source_key)?;
    let state_by_key: HashMap<&str, _> = states.iter().map(|s| (s.file_key.as_str(), s)).collect();
    let scanned_keys: HashSet<String> = docs.iter().map(|d| adapter.file_key(d)).collect();

    let mut archive_folders_ready: HashSet<String> = HashSet::new();
    for doc in &docs {
        let key = adapter.file_key(doc);
        let prior = state_by_key.get(key.as_str());
        let parent_folder_id = resolve_parent(adapter, doc);
        let mut changed = match prior {
            None => true,
            Some(state) => state.fingerprint != doc.fingerprint,
        };
        // 盒子本轮重建 + 条目缺失：无视旧状态强制恢复。
        if !changed && recreated_boxes.contains(&doc.box_id) {
            if let Some(state) = prior {
                changed = storage.get_knowledge(&state.entry_id)?.is_none();
            }
        }
        // 父归属漂移也视为变更（平铺→嵌套迁移、对端移动）。
        if !changed {
            if let Some(state) = prior {
                if let Ok(Some(existing)) = storage.get_knowledge(&state.entry_id) {
                    changed = existing.parent_id != parent_folder_id;
                }
            }
        }
        if !changed {
            continue;
        }
        let is_new = prior.is_none();
        match sync_one_doc(
            storage,
            adapter,
            doc,
            &parent_folder_id,
            is_new,
            started_at_ms,
        ) {
            Ok(true) => report.added += 1,
            Ok(false) => report.updated += 1,
            Err(err) => {
                report.failed.push(KsFailure {
                    file_key: key.clone(),
                    message: err.to_string(),
                });
                continue;
            }
        }
        storage.ks_file_state_upsert(&omnipanel_store::KsFileState {
            source_key: source_key.clone(),
            file_key: key,
            box_id: doc.box_id.clone(),
            rel_path: doc.rel_path.clone(),
            fingerprint: doc.fingerprint.clone(),
            entry_id: adapter.doc_entry_id(&doc.id),
            status: "synced".to_string(),
            updated_at: started_at_ms,
        })?;
    }

    // 对端删除 → 归档。
    for state in &states {
        if scanned_keys.contains(&state.file_key) || state.status == "archived" {
            continue;
        }
        if !folder_ids.contains_key(state.box_id.as_str()) {
            storage.ks_file_state_delete(&source_key, &state.file_key)?;
            continue;
        }
        let Some(existing) = storage.get_knowledge(&state.entry_id)? else {
            storage.ks_file_state_delete(&source_key, &state.file_key)?;
            continue;
        };
        if !archive_folders_ready.contains(&state.box_id) {
            ensure_archive_folder(storage, adapter, &state.box_id, started_at_ms)?;
            archive_folders_ready.insert(state.box_id.clone());
        }
        let mut archived = existing;
        archived.parent_id = adapter.archive_folder_id(&state.box_id);
        archived.updated_at = started_at_ms;
        ensure_tag(&mut archived.tags, &archive_tag);
        storage.save_knowledge(&archived)?;
        storage.ks_file_state_upsert(&omnipanel_store::KsFileState {
            status: "archived".to_string(),
            updated_at: started_at_ms,
            ..state.clone()
        })?;
        report.archived += 1;
    }

    report.finished_at_ms = now_millis();
    persist_report(
        storage,
        &source_key,
        display_name,
        adapter.adapter_kind(),
        &report,
    )?;
    Ok(report)
}

/// 重建同步：清空该源文件状态后全量重评（条目 id 稳定，不产生重复）。
pub fn rebuild_source<A: SourceAdapter>(
    storage: &Storage,
    adapter: &A,
    display_name: &str,
) -> OmniResult<KsReport> {
    storage.ks_file_state_clear(&adapter.source_key())?;
    sync_source(storage, adapter, display_name)
}

/// 同步单个文档：解析 → 镜像资源落盘 → 落库。返回 `true` 表示新增。
fn sync_one_doc<A: SourceAdapter>(
    storage: &Storage,
    adapter: &A,
    doc: &KsDocRef,
    parent_folder_id: &str,
    is_new: bool,
    now_ms: i64,
) -> OmniResult<bool> {
    let content: KsDocContent = adapter.get_document(doc).map_err(OmniError::internal)?;
    let title = if content.title.trim().is_empty() {
        doc.title.clone()
    } else {
        content.title
    };
    let title = if title.trim().is_empty() {
        doc.id.clone()
    } else {
        title
    };
    let entry_id = adapter.doc_entry_id(&doc.id);
    // 解析出的文档标签（命名空间标签保底，解析标签合并）。
    let mut tags = vec![adapter.tag()];
    for tag in &doc.tags {
        ensure_tag(&mut tags, tag);
    }
    let markdown = mirror_assets_to_store(adapter, doc, &entry_id, content.markdown)?;
    match storage.get_knowledge(&entry_id)? {
        None => {
            let mut entry = base_entry(
                entry_id,
                title,
                "document",
                parent_folder_id,
                tags,
                adapter.doc_source(&doc.box_id, &doc.id),
                now_ms,
            );
            entry.content = markdown;
            entry.sort_order = next_sort_order(storage, parent_folder_id)?;
            storage.save_knowledge(&entry)?;
            Ok(is_new)
        }
        Some(mut existing) => {
            existing.title = title;
            existing.content = markdown;
            existing.source = adapter.doc_source(&doc.box_id, &doc.id);
            existing.parent_id = parent_folder_id.to_string();
            existing.updated_at = now_ms;
            existing.tags.retain(|t| t != &adapter.archive_tag());
            for tag in &tags {
                ensure_tag(&mut existing.tags, tag);
            }
            storage.save_knowledge(&existing)?;
            Ok(false)
        }
    }
}

/// 镜像资源落盘：正文 `assets/…` 引用收进条目附件目录并改写为
/// `knowledge-asset://`，孤儿文件清理。仅 asset_managed 适配器走这里；
/// 取不到的引用保留原文（预览破图但不同步炸）。
fn mirror_assets_to_store<A: SourceAdapter>(
    adapter: &A,
    doc: &KsDocRef,
    entry_id: &str,
    markdown: String,
) -> OmniResult<String> {
    if !adapter.asset_managed() {
        return Ok(markdown);
    }
    let refs = extract_asset_refs(&markdown);
    if refs.is_empty() {
        prune_mirror_assets(entry_id, &[])?;
        return Ok(markdown);
    }
    let dir = omnipanel_store::knowledge_entry_assets_dir(entry_id)?;
    let mut out = markdown;
    let mut kept: Vec<String> = Vec::new();
    for rel in &refs {
        match adapter.fetch_asset(doc, rel) {
            Ok(Some((name, bytes))) => {
                if std::fs::write(dir.join(&name), &bytes).is_err() {
                    continue;
                }
                kept.push(name.clone());
                out = out.replace(
                    &format!("]({rel})"),
                    &format!("](knowledge-asset://{entry_id}/{name})"),
                );
            }
            _ => {}
        }
    }
    prune_mirror_assets(entry_id, &kept)?;
    Ok(out)
}

/// 宽容提取正文里的 `assets/…` 引用（到右括号/空白/引号为止；拒绝 `..`）。
fn extract_asset_refs(markdown: &str) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let mut rest = markdown;
    while let Some(idx) = rest.find("](") {
        rest = &rest[idx + 2..];
        let end = rest
            .find(&[')', ' ', '\n', '\t', '"', '\''][..])
            .unwrap_or(rest.len());
        let mut url = rest[..end].trim();
        url = url.trim_start_matches('<').trim_end_matches('>');
        if url.starts_with("assets/")
            && !url.contains("..")
            && url.len() < 512
            && !refs.iter().any(|r| r == url)
        {
            refs.push(url.to_string());
        }
    }
    refs
}

#[cfg(test)]
pub(super) fn extract_asset_refs_for_test(markdown: &str) -> Vec<String> {
    extract_asset_refs(markdown)
}

/// 删除条目附件目录中不在保留集里的文件（镜像只读，无手动粘贴，安全）。
fn prune_mirror_assets(entry_id: &str, kept: &[String]) -> OmniResult<()> {
    let dir = match omnipanel_store::knowledge_entry_assets_dir(entry_id) {
        Ok(dir) => dir,
        Err(_) => return Ok(()),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !kept.iter().any(|k| k == &name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn ensure_archive_folder<A: SourceAdapter>(
    storage: &Storage,
    adapter: &A,
    box_id: &str,
    now_ms: i64,
) -> OmniResult<()> {
    let folder_id = adapter.archive_folder_id(box_id);
    if storage.get_knowledge(&folder_id)?.is_some() {
        return Ok(());
    }
    let parent_folder_id = adapter.folder_entry_id(box_id);
    let mut entry = base_entry(
        folder_id,
        "已归档".to_string(),
        "folder",
        &parent_folder_id,
        vec![adapter.tag(), adapter.archive_tag()],
        adapter.archive_source(box_id),
        now_ms,
    );
    entry.sort_order = next_sort_order(storage, &parent_folder_id)?;
    storage.save_knowledge(&entry)?;
    Ok(())
}

fn persist_report(
    storage: &Storage,
    source_key: &str,
    display_name: &str,
    adapter_kind: &str,
    report: &KsReport,
) -> OmniResult<()> {
    let mut cfg =
        storage
            .ks_config_get(source_key)?
            .unwrap_or_else(|| omnipanel_store::KsSourceConfig {
                source_key: source_key.to_string(),
                display_name: display_name.to_string(),
                adapter: adapter_kind.to_string(),
                config_json: "{}".to_string(),
                secret_ref: String::new(),
                last_sync_at: 0,
                last_report_json: String::new(),
            });
    cfg.display_name = display_name.to_string();
    cfg.last_sync_at = report.finished_at_ms;
    cfg.last_report_json = serde_json::to_string(report).unwrap_or_default();
    storage.ks_config_save(&cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::KsNotebook;
    use std::sync::Mutex;

    /// 内存适配器：笔记本/文档可变，测试增量语义。
    #[derive(Default)]
    struct MemAdapter {
        notebooks: Vec<KsNotebook>,
        docs: Mutex<HashMap<String, (KsDocRef, KsDocContent)>>,
    }

    impl MemAdapter {
        fn with_demo() -> Self {
            let docs = HashMap::from([
                (
                    "d1".to_string(),
                    (
                        KsDocRef {
                            id: "d1".to_string(),
                            title: "文档一".to_string(),
                            parent_id: None,
                            box_id: "nb1".to_string(),
                            rel_path: "d1".to_string(),
                            fingerprint: "v1".to_string(),
                            tags: Vec::new(),
                        },
                        KsDocContent {
                            title: "文档一".to_string(),
                            markdown: "内容一".to_string(),
                            updated_at_ms: None,
                        },
                    ),
                ),
                (
                    "d2".to_string(),
                    (
                        KsDocRef {
                            id: "d2".to_string(),
                            title: "文档二".to_string(),
                            parent_id: None,
                            box_id: "nb1".to_string(),
                            rel_path: "d2".to_string(),
                            fingerprint: "v1".to_string(),
                            tags: Vec::new(),
                        },
                        KsDocContent {
                            title: "文档二".to_string(),
                            markdown: "内容二".to_string(),
                            updated_at_ms: None,
                        },
                    ),
                ),
            ]);
            Self {
                notebooks: vec![KsNotebook {
                    id: "nb1".to_string(),
                    name: "笔记本".to_string(),
                    parent_id: None,
                }],
                docs: Mutex::new(docs),
            }
        }

        fn set_fingerprint(&self, id: &str, fingerprint: &str, markdown: &str) {
            let mut docs = self.docs.lock().unwrap();
            if let Some((doc_ref, content)) = docs.get_mut(id) {
                doc_ref.fingerprint = fingerprint.to_string();
                content.markdown = markdown.to_string();
            }
        }

        fn remove_doc(&self, id: &str) {
            self.docs.lock().unwrap().remove(id);
        }
    }

    impl SourceAdapter for MemAdapter {
        fn namespace(&self) -> &str {
            "demo"
        }

        fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
            Ok(self.notebooks.clone())
        }

        fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
            Ok(self
                .docs
                .lock()
                .unwrap()
                .values()
                .map(|(doc_ref, _)| doc_ref.clone())
                .collect())
        }

        fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
            self.docs
                .lock()
                .unwrap()
                .get(&doc.id)
                .map(|(_, content)| content.clone())
                .ok_or_else(|| format!("缺失文档: {}", doc.id))
        }
    }

    fn mem_storage() -> Storage {
        Storage::open_in_memory().expect("内存库")
    }

    #[test]
    fn full_cycle_add_update_archive() {
        let storage = mem_storage();
        let adapter = MemAdapter::with_demo();

        let report = sync_source(&storage, &adapter, "演示").expect("首轮");
        assert_eq!((report.scanned, report.added), (2, 2));
        let entry = storage
            .get_knowledge("ks-doc-d1")
            .expect("读")
            .expect("d1 在库");
        assert_eq!(entry.title, "文档一");
        assert!(entry.tags.contains(&"demo".to_string()));

        // 二轮无变化。
        let report = sync_source(&storage, &adapter, "演示").expect("二轮");
        assert_eq!((report.added, report.updated, report.archived), (0, 0, 0));

        // 改指纹 → 更新（历史版本自动留）。
        adapter.set_fingerprint("d1", "v2", "内容一改");
        let report = sync_source(&storage, &adapter, "演示").expect("三轮");
        assert_eq!(report.updated, 1);
        assert!(
            !storage
                .list_knowledge_revisions("ks-doc-d1")
                .expect("读历史")
                .is_empty()
        );

        // 对端删除 → 归档（不硬删）。
        adapter.remove_doc("d2");
        let report = sync_source(&storage, &adapter, "演示").expect("四轮");
        assert_eq!(report.archived, 1);
        let archived = storage
            .get_knowledge("ks-doc-d2")
            .expect("读")
            .expect("归档仍在库");
        assert_eq!(archived.parent_id, "ks-archive-nb1");
        assert!(archived.tags.contains(&"demo:archived".to_string()));
    }

    #[test]
    fn rebuild_clears_state_and_refills() {
        let storage = mem_storage();
        let adapter = MemAdapter::with_demo();
        sync_source(&storage, &adapter, "演示").expect("首轮");
        storage.delete_knowledge("ks-doc-d1").expect("丢文档");
        let report = rebuild_source(&storage, &adapter, "演示").expect("重建");
        assert_eq!(report.added, 1);
        assert!(storage.get_knowledge("ks-doc-d1").expect("读").is_some());
    }

    #[test]
    fn recreating_box_heals_missing_docs() {
        let storage = mem_storage();
        let adapter = MemAdapter::with_demo();
        sync_source(&storage, &adapter, "演示").expect("首轮");
        // 整盒删坏（文件夹+文档），状态保留。
        storage.delete_knowledge("ks-doc-d1").expect("删文档");
        storage.delete_knowledge("ks-doc-d2").expect("删文档");
        storage.delete_knowledge("ks-box-nb1").expect("删盒子");
        let report = sync_source(&storage, &adapter, "演示").expect("次轮自愈");
        assert_eq!(report.updated, 2);
        assert!(storage.get_knowledge("ks-doc-d1").expect("读").is_some());
    }

    #[test]
    fn single_doc_delete_is_respected() {
        let storage = mem_storage();
        let adapter = MemAdapter::with_demo();
        sync_source(&storage, &adapter, "演示").expect("首轮");
        storage.delete_knowledge("ks-doc-d1").expect("手删");
        let report = sync_source(&storage, &adapter, "演示").expect("次轮");
        assert_eq!(report.added + report.updated, 0);
    }

    #[test]
    fn broken_doc_does_not_abort_batch() {
        struct BrokenAdapter;
        impl SourceAdapter for BrokenAdapter {
            fn namespace(&self) -> &str {
                "broken"
            }
            fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
                Ok(vec![KsNotebook {
                    id: "nb".to_string(),
                    name: "盒子".to_string(),
                    parent_id: None,
                }])
            }
            fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
                Ok(vec![KsDocRef {
                    id: "bad".to_string(),
                    title: String::new(),
                    parent_id: None,
                    box_id: "nb".to_string(),
                    rel_path: "bad".to_string(),
                    fingerprint: "1".to_string(),
                    tags: Vec::new(),
                }])
            }
            fn get_document(&self, _doc: &KsDocRef) -> Result<KsDocContent, String> {
                Err("boom".to_string())
            }
        }
        let storage = mem_storage();
        let report = sync_source(&storage, &BrokenAdapter, "坏源").expect("整批不炸");
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].file_key.contains("bad"));
    }

    #[test]
    fn report_persists_to_config() {
        let storage = mem_storage();
        let adapter = MemAdapter::with_demo();
        sync_source(&storage, &adapter, "演示").expect("同步");
        let cfg = storage
            .ks_config_get("plugin:demo")
            .expect("读配置")
            .expect("配置应落库");
        assert!(cfg.last_sync_at > 0);
        assert!(cfg.last_report_json.contains("\"added\":2"));
    }

    /// 嵌套归属：rel 父目录名命中同盒文档 id 即挂其下；否则回盒子。
    #[test]
    fn nested_docs_parent_under_matching_doc() {
        let storage = mem_storage();
        struct ThreeDocs;
        impl SourceAdapter for ThreeDocs {
            fn namespace(&self) -> &str {
                "demo"
            }
            fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
                Ok(vec![KsNotebook {
                    id: "nb1".to_string(),
                    name: "笔记本".to_string(),
                    parent_id: None,
                }])
            }
            fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
                let mk = |id: &str, rel: &str| KsDocRef {
                    id: id.to_string(),
                    title: id.to_string(),
                    parent_id: None,
                    box_id: "nb1".to_string(),
                    rel_path: rel.to_string(),
                    fingerprint: "1".to_string(),
                    tags: Vec::new(),
                };
                Ok(vec![
                    mk("parent", "parent.sy"),
                    mk("child", "parent/child.sy"),
                    mk("orphan", "nodir/orphan.sy"),
                ])
            }
            fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
                Ok(KsDocContent {
                    title: doc.id.clone(),
                    markdown: "x".to_string(),
                    updated_at_ms: None,
                })
            }
        }
        let report = sync_source(&storage, &ThreeDocs, "演示").expect("同步");
        assert_eq!(report.added, 3);
        let child = storage
            .get_knowledge("ks-doc-child")
            .expect("读")
            .expect("子在库");
        assert_eq!(child.parent_id, "ks-doc-parent", "子挂父文档下");
        let orphan = storage
            .get_knowledge("ks-doc-orphan")
            .expect("读")
            .expect("孤在库");
        assert_eq!(orphan.parent_id, "ks-box-nb1", "无命中回盒子");
        let parent = storage
            .get_knowledge("ks-doc-parent")
            .expect("读")
            .expect("父在库");
        assert_eq!(parent.parent_id, "ks-box-nb1");
    }

    #[test]
    fn doc_tags_merged_into_entry() {
        // 解析出的文档标签与命名空间标签合并落库；增量更新只增不减。
        let storage = mem_storage();
        struct TaggedAdapter;
        impl SourceAdapter for TaggedAdapter {
            fn namespace(&self) -> &str {
                "demo"
            }
            fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
                Ok(vec![KsNotebook {
                    id: "nb1".to_string(),
                    name: "笔记本".to_string(),
                    parent_id: None,
                }])
            }
            fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
                Ok(vec![KsDocRef {
                    id: "d1".to_string(),
                    title: "文档一".to_string(),
                    parent_id: None,
                    box_id: "nb1".to_string(),
                    rel_path: "d1".to_string(),
                    fingerprint: "1".to_string(),
                    tags: vec!["cnb".to_string(), "personal".to_string()],
                }])
            }
            fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
                Ok(KsDocContent {
                    title: doc.id.clone(),
                    markdown: "x".to_string(),
                    updated_at_ms: None,
                })
            }
        }
        sync_source(&storage, &TaggedAdapter, "演示").expect("同步");
        let entry = storage
            .get_knowledge("ks-doc-d1")
            .expect("读")
            .expect("在库");
        assert!(entry.tags.contains(&"demo".to_string()), "{:?}", entry.tags);
        assert!(entry.tags.contains(&"cnb".to_string()), "{:?}", entry.tags);
        assert!(
            entry.tags.contains(&"personal".to_string()),
            "{:?}",
            entry.tags
        );
        // 增量重跑：标签保留且不重复。
        sync_source(&storage, &TaggedAdapter, "演示").expect("重跑");
        let again = storage
            .get_knowledge("ks-doc-d1")
            .expect("读")
            .expect("在库");
        assert_eq!(again.tags.iter().filter(|t| *t == "cnb").count(), 1);
    }

    #[test]
    fn extract_asset_refs_cases() {
        let md = "![a](assets/x.png) 文本 [f](assets/y.zip \"t\") 外链 [b](https://e.com/z.png) 空 ![](assets/x.png)";
        let refs = super::extract_asset_refs_for_test(md);
        assert_eq!(
            refs,
            vec!["assets/x.png".to_string(), "assets/y.zip".to_string()]
        );
        assert!(super::extract_asset_refs_for_test("无引用").is_empty());
        assert!(super::extract_asset_refs_for_test("![a](../evil.png)").is_empty());
    }

    #[test]
    fn parent_move_triggers_update() {
        // 平铺旧数据 + 新规则重跑 → 父归属漂移计为更新（迁移场景）。
        let storage = mem_storage();
        struct NestedAdapter;
        impl SourceAdapter for NestedAdapter {
            fn namespace(&self) -> &str {
                "demo"
            }
            fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
                Ok(vec![KsNotebook {
                    id: "nb1".to_string(),
                    name: "笔记本".to_string(),
                    parent_id: None,
                }])
            }
            fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
                let mk = |id: &str, rel: &str| KsDocRef {
                    id: id.to_string(),
                    title: id.to_string(),
                    parent_id: None,
                    box_id: "nb1".to_string(),
                    rel_path: rel.to_string(),
                    fingerprint: "1".to_string(),
                    tags: Vec::new(),
                };
                Ok(vec![
                    mk("parent", "parent.sy"),
                    mk("child", "parent/child.sy"),
                ])
            }
            fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
                Ok(KsDocContent {
                    title: doc.id.clone(),
                    markdown: "x".to_string(),
                    updated_at_ms: None,
                })
            }
        }
        // 先手写一条平铺旧条目（parent=盒子）+ 一致的状态。
        storage
            .save_knowledge(&omnipanel_store::KnowledgeEntry {
                id: "ks-doc-child".to_string(),
                kind: "note".to_string(),
                title: "child".to_string(),
                content: "x".to_string(),
                tags: vec!["demo".to_string()],
                risk_level: "safe".to_string(),
                source: "import:ks:demo:doc:nb1/child".to_string(),
                env_tag: "dev".to_string(),
                language: String::new(),
                usage_count: 0,
                created_at: 1,
                updated_at: 1,
                parent_id: "ks-box-nb1".to_string(),
                node_type: "document".to_string(),
                sort_order: 0,
                resource_type: String::new(),
                resource_id: String::new(),
            })
            .expect("写旧条目");
        storage
            .ks_file_state_upsert(&omnipanel_store::KsFileState {
                source_key: "plugin:demo".to_string(),
                file_key: "nb1:parent/child.sy".to_string(),
                box_id: "nb1".to_string(),
                rel_path: "parent/child.sy".to_string(),
                fingerprint: "1".to_string(),
                entry_id: "ks-doc-child".to_string(),
                status: "synced".to_string(),
                updated_at: 1,
            })
            .expect("写旧状态");
        // parent 文档存在 → rel 推导命中，旧 parent=盒子漂移 → 更新且搬家。
        let report = sync_source(&storage, &NestedAdapter, "演示").expect("同步");
        assert_eq!((report.added, report.updated), (1, 1));
        let child = storage
            .get_knowledge("ks-doc-child")
            .expect("读")
            .expect("子在库");
        assert_eq!(child.parent_id, "ks-doc-parent");
    }
}
