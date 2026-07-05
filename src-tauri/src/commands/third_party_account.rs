use omnipanel_store::{ThirdPartyAccount, UpsertThirdPartyAccountInput};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn third_party_account_list(
    state: State<'_, AppState>,
) -> Result<Vec<ThirdPartyAccount>, String> {
    state
        .storage
        .lock()
        .await
        .list_third_party_accounts()
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn third_party_account_upsert(
    state: State<'_, AppState>,
    input: UpsertThirdPartyAccountInput,
) -> Result<ThirdPartyAccount, String> {
    state
        .storage
        .lock()
        .await
        .upsert_third_party_account(input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn third_party_account_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .storage
        .lock()
        .await
        .delete_third_party_account(&id)
        .map_err(|e| e.to_string())
}
