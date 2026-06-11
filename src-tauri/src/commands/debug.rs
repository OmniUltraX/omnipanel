use tauri::WebviewWindow;

/// 打开 WebView DevTools（debug 构建或启用 `debug-inspector` feature 时可用）。
#[tauri::command]
pub fn debug_open_devtools(window: WebviewWindow) -> Result<(), String> {
    #[cfg(any(debug_assertions, feature = "debug-inspector"))]
    {
        window.open_devtools();
        return Ok(());
    }
    #[cfg(not(any(debug_assertions, feature = "debug-inspector")))]
    {
        Err(
            "当前 Release 包未编译 DevTools。请使用 `cargo tauri build --debug`，\
             或 `cargo tauri build --features debug-inspector`，\
             再按 Ctrl+Shift+I 打开。"
                .into(),
        )
    }
}
