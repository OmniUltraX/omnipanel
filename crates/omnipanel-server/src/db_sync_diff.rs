//! 行级差异缓存分页（共享 `omnipanel-db-sync` 实现）。

pub use omnipanel_db_sync::{
    build_row_diff_cache_id, load_row_diff_cache_all, save_row_diff_cache, RowDiffKindCounts,
    RowDiffPageResult, TableRowDiffPayload,
};

pub async fn db_sync_row_diff_page(
    cache_id: String,
    offset: u32,
    limit: u32,
    kinds: Option<Vec<String>>,
) -> Result<RowDiffPageResult, String> {
    omnipanel_db_sync::row_diff_page(&cache_id, offset, limit, kinds)
}
