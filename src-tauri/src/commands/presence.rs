//! 在场验证命令：探测、系统验证、打字签发。

use std::sync::atomic::Ordering;

use omnipanel_error::OmniError;
use omnipanel_presence::{
    PresenceCapability, PresenceKind, PresenceTokenIssued, expected_typed, platform_verifier,
    presence_denied,
};
use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PresenceStatus {
    pub available: bool,
    pub kind: PresenceKind,
    pub os_enabled: bool,
}

fn window_hwnd(window: &tauri::WebviewWindow) -> Option<isize> {
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|h| h.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

#[tauri::command]
#[specta::specta]
pub async fn presence_status(state: State<'_, AppState>) -> Result<PresenceStatus, OmniError> {
    let cap: PresenceCapability = platform_verifier().status();
    Ok(PresenceStatus {
        available: cap.available,
        kind: cap.kind,
        os_enabled: state.os_presence_enabled.load(Ordering::Relaxed),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn presence_set_os_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), OmniError> {
    state.os_presence_enabled.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn presence_verify(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    action: String,
    target: String,
    reason: String,
) -> Result<PresenceTokenIssued, OmniError> {
    if !state.os_presence_enabled.load(Ordering::Relaxed) {
        return Err(presence_denied("已关闭系统验证，请改用确认输入"));
    }
    let hwnd = window_hwnd(&window);
    let issued = tokio::task::spawn_blocking(move || {
        let verifier = platform_verifier();
        if !verifier.status().available {
            return Err(presence_denied("本机不支持系统验证"));
        }
        verifier.verify(&reason, hwnd)?;
        Ok(())
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))??;
    let _ = issued;
    state.presence_tokens.issue(&action, &target)
}

#[tauri::command]
#[specta::specta]
pub async fn presence_issue_typed(
    state: State<'_, AppState>,
    action: String,
    target: String,
    typed: String,
) -> Result<PresenceTokenIssued, OmniError> {
    let expected = expected_typed(&action, &target)?;
    if typed.trim() != expected {
        return Err(presence_denied("输入内容不匹配"));
    }
    state.presence_tokens.issue(&action, &target)
}

#[cfg(test)]
mod tests {
    use omnipanel_presence::{ACTION_DB_RESTART, TokenStore, expected_typed};

    #[test]
    fn typed_restart_expects_restart() {
        assert_eq!(
            expected_typed(ACTION_DB_RESTART, "ssh|mysql|host|a").unwrap(),
            "RESTART"
        );
        let store = TokenStore::system();
        let issued = store.issue(ACTION_DB_RESTART, "ssh|mysql|host|a").unwrap();
        store
            .consume(&issued.token, ACTION_DB_RESTART, "ssh|mysql|host|a")
            .unwrap();
    }
}
