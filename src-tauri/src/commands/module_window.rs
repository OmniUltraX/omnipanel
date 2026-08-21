//! 模块独立 WebView 窗口（如数据库模块弹出）。
//!
//! 策略：用户首次「在新窗口打开」时再创建隐藏 WebView；关闭改为隐藏以复用热 WebView。
//! Windows 配置了 `additionalBrowserArgs` 时必须独立 `data_directory`（与 workspace 子窗相同），
//! 无法与主窗共用。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MODULE_WINDOW_PREFIX: &str = "module-";

fn module_window_label(module_key: &str) -> String {
    let safe = module_key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{MODULE_WINDOW_PREFIX}{safe}")
}

fn webview_data_directory(app: &AppHandle, label: &str) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?
        .join("webview-profiles")
        .join(label);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 webview data dir 失败: {e}"))?;
    Ok(dir)
}

fn default_title(module_key: &str) -> String {
    format!("OmniPanel · {module_key}")
}

/// 确保模块窗存在；不存在则创建（默认隐藏）。已存在则原样返回 label。
pub fn ensure_module_window(app: &AppHandle, module_key: &str) -> Result<String, String> {
    let key = module_key.trim();
    if key.is_empty() {
        return Err("module_key 不能为空".into());
    }

    let label = module_window_label(key);
    if app.get_webview_window(&label).is_some() {
        return Ok(label);
    }

    let data_dir = webview_data_directory(app, &label)?;
    let injected =
        serde_json::to_string(&key).map_err(|e| format!("序列化 module_key 失败: {e}"))?;
    let init_script = format!(
        r##"(function(){{
  try {{
    Object.defineProperty(window, "__OMNIPANEL_MODULE_WINDOW__", {{
      value: {injected},
      writable: false,
      configurable: false
    }});
  }} catch (e) {{
    console.error("[moduleWindow:init]", e);
  }}
}})();"##
    );

    let app_destroy = app.clone();
    let label_destroy = label.clone();
    let key_destroy = key.to_string();

    // URL 参数作为注入脚本的兜底，确保前端 boot 分支能识别模块窗
    let app_url = format!("index.html?win=module&module={key}");
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(app_url.into()))
        .title(default_title(key))
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 560.0)
        .resizable(true)
        .closable(true)
        .decorations(false)
        .focused(false)
        .visible(false)
        // 按需创建时保持隐藏且不占任务栏；show 时再恢复
        .skip_taskbar(true)
        .center()
        .background_color(tauri::window::Color(26, 23, 23, 255))
        // Windows + additionalBrowserArgs：子窗必须独立 data_directory，不能与 main 共用
        .data_directory(data_dir)
        .initialization_script(&init_script)
        .disable_drag_drop_handler()
        .general_autofill_enabled(false);

    let window = builder
        .build()
        .map_err(|e| format!("创建模块窗口失败: {e}"))?;

    let _ = window.set_background_color(Some(tauri::window::Color(26, 23, 23, 255)));
    #[cfg(windows)]
    crate::webview_dpi::hook_window(&window);
    // 尽早触发 snap attach：置 isAttached，按钮进 DOM 后由插件 MutationObserver 补绑
    #[cfg(windows)]
    {
        use tauri_plugin_snap_layout::SnapExt;
        if let Err(e) = app.snap().attach(&window) {
            tracing::debug!("模块窗初始 snap attach 跳过: {e}");
        }
    }

    // 关闭改为隐藏，保持 WebView / JS 堆热复用
    let win_hide = window.clone();
    let app_hide = app.clone();
    let key_hide = key_destroy.clone();
    let label_hide = label_destroy.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = win_hide.set_skip_taskbar(true);
                let _ = win_hide.hide();
                let _ = app_hide.emit(
                    "omnipanel:module-window-hidden",
                    serde_json::json!({
                        "moduleKey": key_hide,
                        "label": label_hide,
                    }),
                );
            }
            tauri::WindowEvent::Destroyed => {
                let _ = app_destroy.emit(
                    "omnipanel:module-window-destroyed",
                    serde_json::json!({
                        "moduleKey": key_destroy,
                        "label": label_destroy,
                    }),
                );
            }
            _ => {}
        }
    });

    Ok(label)
}

/// 按需确保模块窗已创建（保持隐藏）。供前端首次「在新窗口打开」时调用。
#[tauri::command]
pub async fn ensure_module_window_prewarm(
    app: AppHandle,
    module_key: String,
) -> Result<String, String> {
    let key = module_key.trim();
    if key.is_empty() {
        return Err("module_key 不能为空".into());
    }
    ensure_module_window(&app, key)
}

/// 打开（或聚焦）指定模块的独立窗口。`module_key` 如 `database`。
#[tauri::command]
pub async fn open_module_window(
    app: AppHandle,
    module_key: String,
    title: String,
) -> Result<String, String> {
    let key = module_key.trim().to_string();
    if key.is_empty() {
        return Err("module_key 不能为空".into());
    }

    let label = ensure_module_window(&app, &key)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("模块窗口不存在: {label}"))?;

    let win_title = if title.trim().is_empty() {
        default_title(&key)
    } else {
        title
    };
    let _ = window.set_title(&win_title);
    let _ = window.unminimize();
    let _ = window.set_skip_taskbar(false);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    // 显示后再 attach 一次，避免隐藏态 0 尺寸 overlay 未恢复
    #[cfg(windows)]
    {
        use tauri_plugin_snap_layout::SnapExt;
        if let Err(e) = app.snap().attach(&window) {
            tracing::debug!("模块窗 show 后 snap attach 跳过: {e}");
        }
    }

    let _ = app.emit(
        "omnipanel:module-window-shown",
        serde_json::json!({
            "moduleKey": key,
            "label": label,
        }),
    );

    Ok(label)
}
