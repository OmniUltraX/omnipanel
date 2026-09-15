//! 思源本地同步引擎（只读镜像）：扫描 → 比对 mtime → 解析入库 → 归档删除。
//!
//! 语义（故意保守）：
//! - 单文档失败记入报告，不中断整批；
//! - 对端删除 → 本侧**归档**（迁入 `已归档` 文件夹 + 标签），不硬删，历史版本可恢复；
//! - 用户在知识库侧手动删了镜像文档：mtime 未变则**不再复活**（尊重用户删除），
//!   mtime 变了视为对端更新，重新落库；
//! - 更新时保留用户自加标签，只刷新标题/正文/source/归属。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use omnipanel_error::{OmniError, OmniResult};
use omnipanel_store::{SiyuanFileState, SiyuanSyncConfig, Storage};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::mapping;
use crate::scan::{self, SiyuanDocFile};

/// S3 同步尚未实现时的统一错误（配置可存，执行拒绝）。
pub const S3_NOT_READY_MSG: &str = "S3 数据源尚未实现（dejavu 读端开发中），请先使用本地目录数据源";

/// 单文件失败明细。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSyncFailure {
    pub file_key: String,
    pub message: String,
}

/// 一次同步的报告（存配置 `last_report_json`，状态页展示）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSyncReport {
    pub scanned: i64,
    pub added: i64,
    pub updated: i64,
    pub archived: i64,
    pub failed: Vec<SiyuanSyncFailure>,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

fn file_key(file: &SiyuanDocFile) -> String {
    format!("local:{}:{}", file.box_id, file.rel_path)
}

/// 重建同步：清空文件状态后全量重评（删坏重试/状态漂移的显式恢复路径）。
/// 条目 id 稳定可推导，回填覆盖同 id，不会产生重复。
pub fn sync_rebuild(storage: &Storage, cfg: &SiyuanSyncConfig) -> OmniResult<SiyuanSyncReport> {
    storage.siyuan_file_state_clear()?;
    sync_local(storage, cfg)
}

/// Local 数据源一次全量比对同步。
pub fn sync_local(storage: &Storage, cfg: &SiyuanSyncConfig) -> OmniResult<SiyuanSyncReport> {
    cfg.validate().map_err(OmniError::invalid_input)?;
    match cfg.source_type {
        omnipanel_store::SiyuanSourceType::S3 => {
            return Err(OmniError::invalid_input(S3_NOT_READY_MSG));
        }
        omnipanel_store::SiyuanSourceType::Local => {}
    }

    let started_at_ms = scan::now_millis();
    let mut report = SiyuanSyncReport {
        started_at_ms,
        ..Default::default()
    };

    let data_dir = Path::new(cfg.workspace_path.trim());
    let notebooks = scan::list_notebooks(data_dir);
    if notebooks.is_empty() {
        return Err(OmniError::invalid_input(format!(
            "目录下未发现思源笔记本（需要工作空间的 data 目录）: {}",
            data_dir.display()
        )));
    }
    let files = scan::scan_docs(data_dir).map_err(OmniError::internal)?;
    report.scanned = files.len() as i64;

    let box_names: HashMap<&str, &str> = notebooks
        .iter()
        .map(|nb| (nb.id.as_str(), nb.name.as_str()))
        .collect();

    // 笔记本文件夹：缺建，有则刷新标题。
    // 记录本轮重建的盒子：整盒被删后重建时，其下文档即使 mtime 未变也强制重评
    // （否则"删坏重试"场景下文件夹回来、文档永久消失）。
    let mut recreated_boxes: HashSet<String> = HashSet::new();
    for notebook in &notebooks {
        let folder_id = mapping::box_folder_id(&notebook.id);
        match storage.get_knowledge(&folder_id)? {
            None => {
                let mut entry = mapping::box_folder_entry(notebook, started_at_ms);
                entry.sort_order = next_sort_order(storage, "")?;
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

    let states = storage.siyuan_file_state_list()?;
    let state_by_key: HashMap<&str, &SiyuanFileState> =
        states.iter().map(|s| (s.file_key.as_str(), s)).collect();
    let scanned_keys: HashSet<String> = files.iter().map(file_key).collect();

    let mut archive_folders_ready: HashSet<String> = HashSet::new();
    for file in &files {
        let key = file_key(file);
        let prior = state_by_key.get(key.as_str());
        let mut changed = match prior {
            None => true,
            Some(state) => state.mtime_ms != file.mtime_ms,
        };
        // 盒子本轮重建 + 条目缺失：无视旧 state 强制恢复（删坏重试自愈）。
        // 单文档手删（盒子还在）仍被尊重，不复活。
        if !changed
            && recreated_boxes.contains(&file.box_id)
            && let Some(state) = prior
        {
            changed = storage.get_knowledge(&state.entry_id)?.is_none();
        }
        if !changed {
            continue;
        }
        let parent_folder_id = mapping::box_folder_id(&file.box_id);
        match sync_one_file(
            storage,
            file,
            prior.map(|s| s.entry_id.as_str()),
            &parent_folder_id,
            started_at_ms,
        ) {
            Ok(FileSyncOutcome::Added) => report.added += 1,
            Ok(FileSyncOutcome::Updated) => report.updated += 1,
            // 单文件失败只记报告、不中断整批；不写 state，下次同步重试。
            Err(err) => push_failure(&mut report, key.clone(), err.to_string()),
        }
        if report_failed_contains(&report, &key) {
            continue;
        }
        storage.siyuan_file_state_upsert(&SiyuanFileState {
            file_key: key,
            box_id: file.box_id.clone(),
            rel_path: file.rel_path.clone(),
            mtime_ms: file.mtime_ms,
            entry_id: mapping::doc_entry_id(&file.doc_id),
            status: "synced".to_string(),
            updated_at: started_at_ms,
        })?;
    }

    // 对端删除 → 归档（解析失败的文件不进归档判定：只处理扫描到的 state 缺失）。
    for state in &states {
        if scanned_keys.contains(&state.file_key) || state.status == "archived" {
            continue;
        }
        // 笔记本整个删了则只清状态（避免复活）。
        let box_id = state.box_id.clone();
        if !box_names.contains_key(box_id.as_str()) {
            storage.siyuan_file_state_delete(&state.file_key)?;
            continue;
        }
        let Some(existing) = storage.get_knowledge(&state.entry_id)? else {
            storage.siyuan_file_state_delete(&state.file_key)?;
            continue;
        };
        if !archive_folders_ready.contains(&box_id) {
            ensure_archive_folder(storage, &box_id, box_names[box_id.as_str()], started_at_ms)?;
            archive_folders_ready.insert(box_id.clone());
        }
        let archived = mapping::archive_doc_entry(existing, &box_id, started_at_ms);
        storage.save_knowledge(&archived)?;
        storage.siyuan_file_state_upsert(&SiyuanFileState {
            status: "archived".to_string(),
            updated_at: started_at_ms,
            ..state.clone()
        })?;
        report.archived += 1;
    }

    report.finished_at_ms = scan::now_millis();
    let mut cfg_next = cfg.clone();
    cfg_next.last_sync_at = report.finished_at_ms;
    cfg_next.last_report_json = serde_json::to_string(&report).unwrap_or_default();
    storage.siyuan_config_save(&cfg_next)?;
    Ok(report)
}

fn report_failed_contains(report: &SiyuanSyncReport, key: &str) -> bool {
    report.failed.iter().any(|f| f.file_key == key)
}

enum FileSyncOutcome {
    Added,
    Updated,
}

/// 同步单个文件：解析 → 落库。返回 Ok 时调用方负责回写 file_state。
fn sync_one_file(
    storage: &Storage,
    file: &SiyuanDocFile,
    prior_entry_id: Option<&str>,
    parent_folder_id: &str,
    now_ms: i64,
) -> OmniResult<FileSyncOutcome> {
    let text = std::fs::read_to_string(&file.abs_path)
        .map_err(|e| OmniError::internal(format!("读取 {} 失败: {e}", file.rel_path)))?;
    let (title, markdown) = mapping::render_doc(file, &text).map_err(OmniError::invalid_input)?;

    let entry_id = mapping::doc_entry_id(&file.doc_id);
    match storage.get_knowledge(&entry_id)? {
        None => {
            // 有旧 state 但条目没了 = 用户手动删过；能走到这里说明 mtime 变了，
            // 视为对端更新，重新落库（mtime 未变早已在 changed 处跳过）。
            let resurrected = prior_entry_id.is_some();
            let mut entry = mapping::new_doc_entry(file, title, markdown, parent_folder_id, now_ms);
            entry.sort_order = next_sort_order(storage, parent_folder_id)?;
            storage.save_knowledge(&entry)?;
            Ok(if resurrected {
                FileSyncOutcome::Updated
            } else {
                FileSyncOutcome::Added
            })
        }
        Some(existing) => {
            let refreshed = mapping::refresh_doc_entry(
                existing,
                file,
                title,
                markdown,
                parent_folder_id,
                now_ms,
            );
            storage.save_knowledge(&refreshed)?;
            Ok(FileSyncOutcome::Updated)
        }
    }
}

fn ensure_archive_folder(
    storage: &Storage,
    box_id: &str,
    box_name: &str,
    now_ms: i64,
) -> OmniResult<()> {
    let folder_id = mapping::archive_folder_id(box_id);
    if storage.get_knowledge(&folder_id)?.is_some() {
        return Ok(());
    }
    let mut entry = mapping::archive_folder_entry(box_id, box_name, now_ms);
    entry.sort_order = next_sort_order(storage, &mapping::box_folder_id(box_id))?;
    storage.save_knowledge(&entry)?;
    Ok(())
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

/// 同步报告落库失败明细（解析/读取失败不抛错，由调用方收集；S3 数据源复用）。
pub fn push_failure(report: &mut SiyuanSyncReport, file_key: String, message: String) {
    report.failed.push(SiyuanSyncFailure { file_key, message });
}
