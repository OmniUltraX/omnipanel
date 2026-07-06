use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use omnipanel_store::DbConnectionConfig;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::background::db_sync_jobs::TableRowDiffPayload;

const CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowDiffKindCounts {
    pub changed: u32,
    pub source_only: u32,
    pub target_only: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowDiffCacheFile {
    version: u32,
    table: String,
    diff_rows: u32,
    kind_counts: RowDiffKindCounts,
    diffs: Vec<TableRowDiffPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowDiffPageResult {
    pub diffs: Vec<TableRowDiffPayload>,
    pub total: u32,
    pub kind_counts: RowDiffKindCounts,
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?
        .join("sync-row-diffs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 sync-row-diffs 目录失败: {e}"))?;
    Ok(dir)
}

fn cache_path(app: &AppHandle, cache_id: &str) -> Result<PathBuf, String> {
    let safe_id = cache_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    Ok(cache_dir(app)?.join(format!("{safe_id}.json")))
}

fn count_kinds(diffs: &[TableRowDiffPayload]) -> RowDiffKindCounts {
    let mut changed = 0u32;
    let mut source_only = 0u32;
    let mut target_only = 0u32;
    for diff in diffs {
        match diff.kind.as_str() {
            "changed" => changed += 1,
            "sourceOnly" => source_only += 1,
            "targetOnly" => target_only += 1,
            _ => {}
        }
    }
    RowDiffKindCounts {
        changed,
        source_only,
        target_only,
    }
}

fn load_cache_file(app: &AppHandle, cache_id: &str) -> Result<RowDiffCacheFile, String> {
    static MEM_CACHE: OnceLock<Mutex<HashMap<String, RowDiffCacheFile>>> = OnceLock::new();
    let mem = MEM_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Ok(guard) = mem.lock() {
        if let Some(cached) = guard.get(cache_id) {
            return Ok(cached.clone());
        }
    }

    let path = cache_path(app, cache_id)?;
    if !path.exists() {
        return Err(format!("差异缓存不存在: {cache_id}"));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("读取差异缓存失败 ({}): {e}", path.display()))?;
    let file: RowDiffCacheFile = serde_json::from_str(&raw)
        .map_err(|e| format!("解析差异缓存失败 ({}): {e}", path.display()))?;

    if let Ok(mut guard) = mem.lock() {
        guard.insert(cache_id.to_string(), file.clone());
    }
    Ok(file)
}

/// 根据源/目标连接与表名生成稳定的本地缓存 ID。
pub fn build_row_diff_cache_id(
    source: &DbConnectionConfig,
    target: &DbConnectionConfig,
    table_name: &str,
) -> String {
    let mut hasher = DefaultHasher::new();
    source.host.hash(&mut hasher);
    source.port.hash(&mut hasher);
    source.db_type.hash(&mut hasher);
    source.database.hash(&mut hasher);
    target.host.hash(&mut hasher);
    target.port.hash(&mut hasher);
    target.db_type.hash(&mut hasher);
    target.database.hash(&mut hasher);
    table_name.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// 保存表行级差异到本地缓存，供冲突详情分页读取。
pub fn save_row_diff_cache(
    app: &AppHandle,
    cache_id: &str,
    table: &str,
    diffs: &[TableRowDiffPayload],
) -> Result<(), String> {
    let kind_counts = count_kinds(diffs);
    let file = RowDiffCacheFile {
        version: CACHE_VERSION,
        table: table.to_string(),
        diff_rows: diffs.len() as u32,
        kind_counts,
        diffs: diffs.to_vec(),
    };

    let path = cache_path(app, cache_id)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string(&file).map_err(|e| format!("序列化差异缓存失败: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("写入差异缓存失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换差异缓存失败: {e}"))?;

    static MEM_CACHE: OnceLock<Mutex<HashMap<String, RowDiffCacheFile>>> = OnceLock::new();
    let mem = MEM_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = mem.lock() {
        guard.insert(cache_id.to_string(), file);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn db_sync_row_diff_page(
    app: AppHandle,
    cache_id: String,
    offset: u32,
    limit: u32,
    kinds: Option<Vec<String>>,
) -> Result<RowDiffPageResult, String> {
    let file = load_cache_file(&app, &cache_id)?;
    let limit = limit.max(1).min(500);
    let offset = offset as usize;

    let filter_kinds: Option<Vec<String>> = kinds.map(|items| {
        items
            .into_iter()
            .filter(|k| !k.trim().is_empty())
            .collect()
    });

    let filtered: Vec<&TableRowDiffPayload> = if let Some(ref kinds) = filter_kinds {
        if kinds.is_empty() {
            file.diffs.iter().collect()
        } else {
            file.diffs
                .iter()
                .filter(|d| kinds.iter().any(|k| k == &d.kind))
                .collect()
        }
    } else {
        file.diffs.iter().collect()
    };

    let total = filtered.len() as u32;
    let page: Vec<TableRowDiffPayload> = filtered
        .into_iter()
        .skip(offset)
        .take(limit as usize)
        .cloned()
        .collect();

    Ok(RowDiffPageResult {
        diffs: page,
        total,
        kind_counts: file.kind_counts,
    })
}
