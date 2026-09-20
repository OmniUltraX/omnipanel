use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use omnipanel_store::DbConnectionConfig;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::paths::row_diff_cache_dir;

/// v1：单文件 JSON 内嵌全部 diffs（大表易 OOM）。
/// v2：meta JSON + NDJSON 行文件，比较过程可流式落盘。
const CACHE_VERSION: u32 = 2;
/// 内存缓存仅保留元数据，避免百万级 diffs 常驻进程。
const MEM_CACHE_MAX_DIFFS_INLINE: u32 = 500;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableRowDiffPayload {
    pub row_key: String,
    pub display_key: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    pub source_row: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    pub target_row: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowDiffKindCounts {
    pub changed: u32,
    pub source_only: u32,
    pub target_only: u32,
}

impl Default for RowDiffKindCounts {
    fn default() -> Self {
        Self {
            changed: 0,
            source_only: 0,
            target_only: 0,
        }
    }
}

impl RowDiffKindCounts {
    fn bump(&mut self, kind: &str) {
        match kind {
            "changed" => self.changed = self.changed.saturating_add(1),
            "sourceOnly" => self.source_only = self.source_only.saturating_add(1),
            "targetOnly" => self.target_only = self.target_only.saturating_add(1),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowDiffCacheMeta {
    version: u32,
    table: String,
    diff_rows: u32,
    kind_counts: RowDiffKindCounts,
    /// v1 兼容：若存在则 diffs 内嵌在本文件。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    diffs: Vec<TableRowDiffPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowDiffPageResult {
    pub diffs: Vec<TableRowDiffPayload>,
    pub total: u32,
    pub kind_counts: RowDiffKindCounts,
}

#[derive(Clone)]
struct MemCacheEntry {
    meta: RowDiffCacheMeta,
}

fn mem_cache() -> &'static Mutex<HashMap<String, MemCacheEntry>> {
    static MEM_CACHE: OnceLock<Mutex<HashMap<String, MemCacheEntry>>> = OnceLock::new();
    MEM_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_paths(cache_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = row_diff_cache_dir()?;
    let safe_id = cache_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    Ok((
        dir.join(format!("{safe_id}.json")),
        dir.join(format!("{safe_id}.ndjson")),
    ))
}

fn load_meta_from_disk(cache_id: &str) -> Result<RowDiffCacheMeta, String> {
    let (meta_path, _) = cache_paths(cache_id)?;
    if !meta_path.exists() {
        return Err(format!("差异缓存不存在: {cache_id}"));
    }
    let raw = fs::read_to_string(&meta_path)
        .map_err(|e| format!("读取差异缓存失败 ({}): {e}", meta_path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("解析差异缓存失败 ({}): {e}", meta_path.display()))
}

fn remember_meta(cache_id: &str, meta: &RowDiffCacheMeta) {
    // 大结果只缓存元数据，避免把整表差异再拷进进程堆。
    let store = if meta.diff_rows <= MEM_CACHE_MAX_DIFFS_INLINE && !meta.diffs.is_empty() {
        meta.clone()
    } else {
        RowDiffCacheMeta {
            version: meta.version,
            table: meta.table.clone(),
            diff_rows: meta.diff_rows,
            kind_counts: meta.kind_counts.clone(),
            diffs: Vec::new(),
        }
    };
    if let Ok(mut guard) = mem_cache().lock() {
        guard.insert(
            cache_id.to_string(),
            MemCacheEntry { meta: store },
        );
    }
}

fn load_meta(cache_id: &str) -> Result<RowDiffCacheMeta, String> {
    if let Ok(guard) = mem_cache().lock() {
        if let Some(cached) = guard.get(cache_id) {
            return Ok(cached.meta.clone());
        }
    }
    let meta = load_meta_from_disk(cache_id)?;
    remember_meta(cache_id, &meta);
    Ok(meta)
}

/// 根据源/目标连接、表名与忽略字段生成稳定的本地缓存 ID。
pub fn build_row_diff_cache_id(
    source: &DbConnectionConfig,
    target: &DbConnectionConfig,
    table_name: &str,
    ignored_fields: &HashSet<String>,
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
    let mut ignored: Vec<&String> = ignored_fields.iter().collect();
    ignored.sort();
    for entry in ignored {
        entry.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// 流式写入行差异缓存（NDJSON），避免比较过程中把全部 diffs 攒在内存。
pub struct RowDiffCacheWriter {
    cache_id: String,
    table: String,
    meta_path: PathBuf,
    ndjson_path: PathBuf,
    writer: BufWriter<File>,
    diff_rows: u32,
    kind_counts: RowDiffKindCounts,
    preview: Vec<TableRowDiffPayload>,
    preview_limit: usize,
}

impl RowDiffCacheWriter {
    pub fn create(cache_id: &str, table: &str, preview_limit: usize) -> Result<Self, String> {
        let (meta_path, ndjson_path) = cache_paths(cache_id)?;
        if let Some(parent) = meta_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建差异缓存目录失败: {e}"))?;
        }
        let file = File::create(&ndjson_path)
            .map_err(|e| format!("创建差异 NDJSON 失败 ({}): {e}", ndjson_path.display()))?;
        Ok(Self {
            cache_id: cache_id.to_string(),
            table: table.to_string(),
            meta_path,
            ndjson_path,
            writer: BufWriter::new(file),
            diff_rows: 0,
            kind_counts: RowDiffKindCounts::default(),
            preview: Vec::new(),
            preview_limit,
        })
    }

    pub fn push(&mut self, diff: TableRowDiffPayload) -> Result<(), String> {
        serde_json::to_writer(&mut self.writer, &diff)
            .map_err(|e| format!("写入差异 NDJSON 失败: {e}"))?;
        self.writer
            .write_all(b"\n")
            .map_err(|e| format!("写入差异 NDJSON 换行失败: {e}"))?;
        self.kind_counts.bump(&diff.kind);
        self.diff_rows = self.diff_rows.saturating_add(1);
        if self.preview.len() < self.preview_limit {
            self.preview.push(diff);
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<(String, u32, Vec<TableRowDiffPayload>), String> {
        self.writer
            .flush()
            .map_err(|e| format!("刷新差异 NDJSON 失败: {e}"))?;
        drop(self.writer);

        let meta = RowDiffCacheMeta {
            version: CACHE_VERSION,
            table: self.table,
            diff_rows: self.diff_rows,
            kind_counts: self.kind_counts,
            diffs: Vec::new(),
        };
        let tmp = self.meta_path.with_extension("json.tmp");
        let json = serde_json::to_string(&meta).map_err(|e| format!("序列化差异元数据失败: {e}"))?;
        fs::write(&tmp, json).map_err(|e| format!("写入差异元数据失败: {e}"))?;
        fs::rename(&tmp, &self.meta_path).map_err(|e| format!("替换差异元数据失败: {e}"))?;

        remember_meta(&self.cache_id, &meta);
        // 空差异时删掉空 ndjson，保持目录干净
        if self.diff_rows == 0 {
            let _ = fs::remove_file(&self.ndjson_path);
        }
        Ok((self.cache_id, self.diff_rows, self.preview))
    }
}

/// 保存表行级差异到本地缓存，供冲突详情分页读取。
pub fn save_row_diff_cache(
    cache_id: &str,
    table: &str,
    diffs: &[TableRowDiffPayload],
) -> Result<(), String> {
    let mut writer = RowDiffCacheWriter::create(cache_id, table, diffs.len())?;
    for diff in diffs {
        writer.push(diff.clone())?;
    }
    let _ = writer.finish()?;
    Ok(())
}

fn for_each_diff_line<F>(cache_id: &str, mut visit: F) -> Result<(), String>
where
    F: FnMut(TableRowDiffPayload) -> Result<bool, String>,
{
    // 始终从磁盘读差异正文：内存缓存可能只留了元数据（避免大结果常驻堆）。
    let meta = load_meta_from_disk(cache_id)?;
    if !meta.diffs.is_empty() {
        for diff in meta.diffs {
            if !visit(diff)? {
                break;
            }
        }
        return Ok(());
    }

    let (_, ndjson_path) = cache_paths(cache_id)?;
    if !ndjson_path.exists() {
        if meta.diff_rows == 0 {
            return Ok(());
        }
        return Err(format!("差异 NDJSON 不存在: {cache_id}"));
    }

    let file = File::open(&ndjson_path)
        .map_err(|e| format!("打开差异 NDJSON 失败 ({}): {e}", ndjson_path.display()))?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.map_err(|e| format!("读取差异 NDJSON 失败: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let diff: TableRowDiffPayload = serde_json::from_str(&line)
            .map_err(|e| format!("解析差异 NDJSON 行失败: {e}"))?;
        if !visit(diff)? {
            break;
        }
    }
    Ok(())
}

/// 读取差异缓存中的全部行（供 SQL 生成使用）。大结果集会占用内存，优先用 [`for_each_row_diff`]。
pub fn load_row_diff_cache_all(cache_id: &str) -> Result<Vec<TableRowDiffPayload>, String> {
    let mut out = Vec::new();
    for_each_diff_line(cache_id, |diff| {
        out.push(diff);
        Ok(true)
    })?;
    Ok(out)
}

/// 逐条回调差异行，避免 SQL 生成时整表 diffs 进内存。
/// 回调返回 `Ok(false)` 可提前结束扫描。
pub fn for_each_row_diff<F>(cache_id: &str, mut visit: F) -> Result<(), String>
where
    F: FnMut(TableRowDiffPayload) -> Result<bool, String>,
{
    for_each_diff_line(cache_id, |diff| visit(diff))
}

/// 分页读取差异缓存（供 UI 冲突详情展示）。
pub fn row_diff_page(
    cache_id: &str,
    offset: u32,
    limit: u32,
    kinds: Option<Vec<String>>,
) -> Result<RowDiffPageResult, String> {
    let meta = load_meta(cache_id)?;
    let limit = limit.max(1).min(500);
    let offset = offset as usize;
    let filter_kinds: Option<HashSet<String>> = kinds.map(|items| {
        items
            .into_iter()
            .filter(|k| !k.trim().is_empty())
            .collect()
    });

    let mut matched = 0usize;
    let mut page: Vec<TableRowDiffPayload> = Vec::new();
    let mut total_filtered = 0u32;

    for_each_diff_line(cache_id, |diff| {
        let keep = match &filter_kinds {
            Some(kinds) if !kinds.is_empty() => kinds.contains(&diff.kind),
            _ => true,
        };
        if !keep {
            return Ok(true);
        }
        total_filtered = total_filtered.saturating_add(1);
        if matched >= offset && page.len() < limit as usize {
            page.push(diff);
        }
        matched = matched.saturating_add(1);
        Ok(true)
    })?;

    // 无 kind 过滤时 total 可直接用元数据，避免扫描误差；有过滤必须用扫描计数。
    let total = match &filter_kinds {
        Some(kinds) if !kinds.is_empty() => total_filtered,
        _ => meta.diff_rows,
    };

    Ok(RowDiffPageResult {
        diffs: page,
        total,
        kind_counts: meta.kind_counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_cache_dir<F, R>(f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let _guard = TEST_DIR_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        // SAFETY: 单测串行，且仅改本进程环境变量指向临时目录。
        unsafe {
            std::env::set_var("OMNIPANEL_ROW_DIFF_CACHE_DIR", dir.path());
        }
        let out = f();
        unsafe {
            std::env::remove_var("OMNIPANEL_ROW_DIFF_CACHE_DIR");
        }
        out
    }

    #[test]
    fn streaming_writer_roundtrip_and_page() {
        with_temp_cache_dir(|| {
            let mut writer = RowDiffCacheWriter::create("test_cache", "t1", 2).expect("writer");
            for i in 0..5 {
                writer
                    .push(TableRowDiffPayload {
                        row_key: format!("k{i}"),
                        display_key: format!("id={i}"),
                        kind: if i % 2 == 0 {
                            "changed".into()
                        } else {
                            "sourceOnly".into()
                        },
                        changed_fields: Some(vec!["c".into()]),
                        source_row: None,
                        target_row: None,
                    })
                    .expect("push");
            }
            let (id, count, preview) = writer.finish().expect("finish");
            assert_eq!(id, "test_cache");
            assert_eq!(count, 5);
            assert_eq!(preview.len(), 2);

            let page = row_diff_page("test_cache", 1, 2, None).expect("page");
            assert_eq!(page.total, 5);
            assert_eq!(page.diffs.len(), 2);
            assert_eq!(page.diffs[0].row_key, "k1");
            assert_eq!(page.kind_counts.changed, 3);
            assert_eq!(page.kind_counts.source_only, 2);

            let all = load_row_diff_cache_all("test_cache").expect("all");
            assert_eq!(all.len(), 5);
        });
    }
}
