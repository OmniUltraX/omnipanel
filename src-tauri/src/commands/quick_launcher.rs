//! 快捷启动窗（无边框、独立 WebView；全局快捷键随时可用）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickLauncherShownPayload {
    /// Ctrl+Space 唤醒时为 true：前端可直接显示热键角标，无需再按一次 Ctrl
    ctrl_held: bool,
}

pub const QUICK_LAUNCHER_LABEL: &str = "quick-launcher";

/// Windows 上 hide 后 HWND 偶发仍占命中区；移到屏外彻底避开光标。
const LAUNCHER_PARK_X: i32 = -32000;
const LAUNCHER_PARK_Y: i32 = -32000;

static TRAY_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 前端在进出托盘时同步（供其它逻辑查询；快捷启动不再依赖此标志）。
#[tauri::command]
pub fn set_app_tray_active(active: bool) {
    TRAY_ACTIVE.store(active, Ordering::SeqCst);
}

#[tauri::command]
pub fn get_app_tray_active() -> bool {
    TRAY_ACTIVE.load(Ordering::SeqCst)
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

mod geometry {
    include!("launcher_geometry.rs");
}

fn center_on_cursor_monitor(app: &AppHandle, window: &tauri::WebviewWindow, height: f64) {
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    let cursor = app.cursor_position().ok();
    let target = monitors
        .iter()
        .find(|m| {
            cursor.is_some_and(|c| {
                let p = m.position();
                let size = m.size();
                c.x >= p.x as f64
                    && c.x < p.x as f64 + size.width as f64
                    && c.y >= p.y as f64
                    && c.y < p.y as f64 + size.height as f64
            })
        })
        .or_else(|| monitors.first());
    let Some(mon) = target else {
        return;
    };
    let area = mon.work_area();
    // GTK resize requests are asynchronous. Cached outer_size() can still be
    // the parked 1x1 (or stale pre-map allocation); use the requested dimensions.
    let (x, y, width, height) = geometry::launcher_bounds(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        mon.scale_factor(),
        height,
    );
    let _ = window.set_min_size(Some(tauri::PhysicalSize::new(
        width.min((520.0 * mon.scale_factor()).round() as u32),
        height.min((104.0 * mon.scale_factor()).round() as u32),
    )));
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 停靠到屏外并隐藏，避免 always_on_top / 无边框窗在 Windows 上留下隐形命中区。
fn park_and_hide_launcher(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Tao/GTK unwraps the native GdkWindow for cursor passthrough. A newly
    // created hidden Linux window is not realized yet; calling this aborts the
    // entire process, even though the returned Result is ignored. Hidden GTK
    // windows cannot intercept pointer events, so no passthrough is needed.
    #[cfg(not(target_os = "linux"))]
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_always_on_top(false);
    // Off-screen 1x1 parking is a Windows hit-test workaround. GTK remembers
    // these hidden allocations/positions and remaps the popup outside the work
    // area on subsequent shows; hide alone is sufficient on Linux.
    #[cfg(not(target_os = "linux"))]
    {
        // 创建时 min 为 520×104，不先放开则 set_size(1×1) 会被钳住，屏外停靠失效时仍占大命中区
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(1.0, 1.0)));
        // 先移出屏幕再缩、再 hide：即使 hide 后 HWND 仍参与 hit-test，光标也碰不到
        let _ = window.set_position(tauri::PhysicalPosition::new(
            LAUNCHER_PARK_X,
            LAUNCHER_PARK_Y,
        ));
        let _ = window.set_size(tauri::LogicalSize::new(1.0, 1.0));
    }
    window.hide().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    force_win32_hide(window);
    Ok(())
}

#[cfg(windows)]
fn force_win32_hide(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};

    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return;
    };
    let hwnd = HWND(win32.hwnd.get() as *mut _);
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

/// 启动时预创建（隐藏）。失败不阻断主流程。
pub fn ensure_quick_launcher_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(QUICK_LAUNCHER_LABEL).is_some() {
        return Ok(());
    }

    let data_dir = webview_data_directory(app, QUICK_LAUNCHER_LABEL)?;
    let init_script = r##"(function(){
  try {
    Object.defineProperty(window, "__OMNIPANEL_QUICK_LAUNCHER__", {
      value: true,
      writable: false,
      configurable: false
    });
  } catch (e) {
    console.error("[quickLauncher:init]", e);
  }
})();"##;

    let builder = WebviewWindowBuilder::new(
        app,
        QUICK_LAUNCHER_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("OmniPanel Quick Launcher")
    .inner_size(600.0, 104.0)
    .min_inner_size(520.0, 104.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .background_color(tauri::window::Color(22, 24, 28, 255))
    .data_directory(data_dir)
    .initialization_script(init_script)
    .disable_drag_drop_handler()
    .general_autofill_enabled(false);

    let window = builder
        .build()
        .map_err(|e| format!("创建快捷启动窗失败: {e}"))?;

    let _ = window.set_background_color(Some(tauri::window::Color(22, 24, 28, 255)));
    #[cfg(windows)]
    crate::webview_dpi::hook_window(&window);

    // 关闭请求改为隐藏，保持常驻
    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = park_and_hide_launcher(&win);
        }
    });

    // 创建后立刻停靠屏外，避免预创建窗短暂占位
    let _ = park_and_hide_launcher(&window);

    Ok(())
}

fn show_launcher(app: &AppHandle, ctrl_held: bool) -> Result<(), String> {
    ensure_quick_launcher_window(app)?;
    let window = app
        .get_webview_window(QUICK_LAUNCHER_LABEL)
        .ok_or_else(|| "快捷启动窗不存在".to_string())?;

    // 独立 WebView 常驻时易漏收 Vite HMR：若前端尚未挂上页内 AI 标记，先 reload 一次。
    let _ = window.eval(
        r#"(function(){
  try {
    if (window.__OMNIPANEL_QL_HAS_INPANEL_AI__ === true) return;
    location.reload();
  } catch (e) {}
})();"#,
    );

    // 从屏外停靠恢复：恢复最小尺寸 → 正常尺寸 → 命中/置顶 → 定位显示
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(520.0, 104.0)));
    let _ = window.set_size(tauri::LogicalSize::new(600.0, 104.0));
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_always_on_top(true);
    center_on_cursor_monitor(app, &window, 104.0);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        // Map/configure events may override a pre-show GTK move. Reapply only
        // while visible, after the WM has realized the window; no thread sleep.
        let app = app.clone();
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            if window.is_visible().unwrap_or(false) {
                let height = window
                    .inner_size()
                    .ok()
                    .and_then(|size| {
                        window
                            .scale_factor()
                            .ok()
                            .map(|scale| size.height as f64 / scale)
                    })
                    .unwrap_or(104.0);
                center_on_cursor_monitor(&app, &window, height);
            }
        });
    }
    let _ = app.emit(
        "omnipanel:quick-launcher-shown",
        QuickLauncherShownPayload { ctrl_held },
    );
    Ok(())
}

fn hide_launcher(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_LAUNCHER_LABEL) {
        park_and_hide_launcher(&window)?;
        let _ = app.emit("omnipanel:quick-launcher-hidden", ());
    }
    Ok(())
}

/// 托盘菜单 / 前端调用：显示启动窗（不校验托盘态，由调用方保证）。
#[tauri::command]
pub fn show_quick_launcher(app: AppHandle) -> Result<(), String> {
    show_launcher(&app, false)
}

#[tauri::command]
pub fn hide_quick_launcher(app: AppHandle) -> Result<(), String> {
    hide_launcher(&app)
}

/// 切换显隐。返回当前是否可见。
/// `from_hotkey`：Ctrl+Space 唤醒时传 true，前端直接显示 Ctrl 角标。
fn toggle_quick_launcher_inner(app: AppHandle, from_hotkey: bool) -> Result<bool, String> {
    ensure_quick_launcher_window(&app)?;
    let window = app
        .get_webview_window(QUICK_LAUNCHER_LABEL)
        .ok_or_else(|| "快捷启动窗不存在".to_string())?;
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        hide_launcher(&app)?;
        Ok(false)
    } else {
        show_launcher(&app, from_hotkey)?;
        Ok(true)
    }
}

#[tauri::command]
pub fn toggle_quick_launcher(app: AppHandle) -> Result<bool, String> {
    toggle_quick_launcher_inner(app, false)
}

/// 调整启动窗高度（结果列表变化时由前端调用）。
#[tauri::command]
pub fn set_quick_launcher_height(app: AppHandle, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_LAUNCHER_LABEL)
        .ok_or_else(|| "快捷启动窗不存在".to_string())?;
    // 隐藏/屏外停靠时不改尺寸，避免把 1×1 停靠窗拉回可见命中区
    if !window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    // 顶部模块图标行 + 搜索行，最小约 104
    let h = height.clamp(104.0, 480.0);
    center_on_cursor_monitor(&app, &window, h);
    Ok(())
}

/// 注册 Ctrl+Space；失败仅打日志（常见于被系统/输入法占用）。
pub fn register_global_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    let app_handle = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _s, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let app = app.clone();
            // 避免在快捷键回调里同步阻塞 UI
            tauri::async_runtime::spawn(async move {
                // 极短延迟，降低与输入法抢焦点的竞态
                tokio::time::sleep(Duration::from_millis(16)).await;
                let _ = toggle_quick_launcher_inner(app, true);
            });
        })
    {
        tracing::warn!("注册快捷启动快捷键处理器失败: {e}");
        return;
    }
    if let Err(e) = app.global_shortcut().register(shortcut) {
        tracing::warn!("注册 Ctrl+Space 失败（可能被占用）: {e}");
    } else {
        tracing::info!("快捷启动全局快捷键已注册: Ctrl+Space");
    }
    let _ = app_handle;
}
