use omnipanel_db_sync::row_diff_page;
use tauri::AppHandle;

pub use omnipanel_db_sync::RowDiffPageResult;

/// 分页读取行级差异缓存（`AppHandle` 参数保留 IPC 签名兼容，逻辑在共享 crate）。
#[tauri::command]
#[specta::specta]
pub async fn db_sync_row_diff_page(
    _app: AppHandle,
    cache_id: String,
    offset: u32,
    limit: u32,
    kinds: Option<Vec<String>>,
) -> Result<RowDiffPageResult, String> {
    row_diff_page(&cache_id, offset, limit, kinds)
}
