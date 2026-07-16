use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LOG_REL: &str = "workspace-window-debug.log";

fn workspace_window_label(workspace_id: &str) -> String {
    let safe = urlencoding::encode(workspace_id).replace('%', "_");
    format!("workspace-{safe}")
}

fn app_data_log_path(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        return dir.join(LOG_REL);
    }
    std::env::temp_dir().join(format!("omnipanel-{LOG_REL}"))
}

fn append_log(app: &AppHandle, line: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let entry = format!("[{ts}] {line}\n");
    eprintln!("[workspace-window] {line}");
    tracing::info!(target: "workspace_window", "{line}");

    for path in [
        app_data_log_path(app),
        std::env::temp_dir().join(format!("omnipanel-{LOG_REL}")),
    ] {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(entry.as_bytes());
            let _ = f.flush();
        }
    }
}

fn handoff_path(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?
        .join("workspace-window-handoff");
    let _ = std::fs::create_dir_all(&dir);
    let safe = urlencoding::encode(workspace_id).replace('%', "_");
    Ok(dir.join(format!("{safe}.json")))
}

/// 每个子 WebView 独立 data_directory。
/// Windows + `additionalBrowserArgs`（见 tauri.windows.conf.json）时，
/// 多窗共享同一 data dir 会导致第二窗白屏/卡死（tauri#13092 / #15014）。
fn webview_data_directory(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?
        .join("webview-profiles")
        .join(label);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 webview data dir 失败: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn workspace_window_debug_log(app: AppHandle, message: String) -> Result<String, String> {
    append_log(&app, &message);
    Ok(app_data_log_path(&app).display().to_string())
}

/// 清理过期的 handoff 文件（TTL 5 分钟）。
///
/// 应用崩溃后 handoff 文件可能残留，重启时若直接恢复可能读到不一致的状态。
/// 启动时调用此命令清理超过 TTL 的文件；未过期的文件保留，以便正常恢复。
#[tauri::command]
pub fn cleanup_expired_handoffs(app: AppHandle) -> Result<usize, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?
        .join("workspace-window-handoff");

    if !dir.is_dir() {
        return Ok(0);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let ttl_ms: u128 = 300_000; // 5 分钟

    let mut cleaned = 0usize;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    let age = now.saturating_sub(
                        modified
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0),
                    );
                    if age > ttl_ms {
                        if std::fs::remove_file(entry.path()).is_ok() {
                            cleaned += 1;
                        }
                    }
                }
            }
        }
    }
    Ok(cleaned)
}

#[tauri::command]
pub fn workspace_window_debug_log_read(app: AppHandle) -> Result<String, String> {
    let path = app_data_log_path(&app);
    if !path.is_file() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_window_debug_log_path(app: AppHandle) -> Result<String, String> {
    Ok(app_data_log_path(&app).display().to_string())
}

/// 写入 handoff（弹出前主窗写入 open；关闭前子窗写入 close）。
#[tauri::command]
pub fn write_workspace_window_handoff(
    app: AppHandle,
    workspace_id: String,
    handoff_json: String,
) -> Result<(), String> {
    let path = handoff_path(&app, &workspace_id)?;
    std::fs::write(&path, handoff_json).map_err(|e| format!("写入 handoff 失败: {e}"))?;
    append_log(
        &app,
        &format!("handoff written {}", path.display()),
    );
    Ok(())
}

/// 独立窗口读取主窗口写入的 handoff（因各窗 data_directory 不同，不能靠 localStorage）。
#[tauri::command]
pub fn read_workspace_window_handoff(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let path = handoff_path(&app, &workspace_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
pub fn clear_workspace_window_handoff(
    app: AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    let path = handoff_path(&app, &workspace_id)?;
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
pub async fn close_all_workspace_windows(app: AppHandle) -> Result<usize, String> {
    let mut closed = 0usize;
    for (label, window) in app.webview_windows() {
        if !label.starts_with("workspace-") {
            continue;
        }
        append_log(&app, &format!("force-close label={label}"));
        if window.destroy().is_ok() {
            closed += 1;
        }
    }
    Ok(closed)
}

/// 退出整个应用进程（托盘常驻 / 多窗口隐藏后也需要此路径）。
#[tauri::command]
pub fn app_exit(app: AppHandle) {
    append_log(&app, "app_exit");
    app.exit(0);
}

/// 根据屏幕坐标（物理像素）命中 Webview 窗口 label，用于跨窗口 tab 拖拽落点判定。
///
/// `exclude_label` 为源窗 label，跳过它：跨窗拖拽中源窗永远不可能是 drop 目标。
///
/// 多窗口重叠时使用 Win32 EnumWindows 获取真实 z-order，返回最顶层的命中窗口。
/// `is_focused()` 不可靠：拖拽中源窗持有 focus，目标窗均非 focused。
#[tauri::command]
pub fn window_label_at_screen_point(
    app: AppHandle,
    x: f64,
    y: f64,
    exclude_label: Option<String>,
) -> Option<String> {
    // 获取按 z-order 排序（顶→底）的 label 列表
    let z_ordered_labels = window_z_order_impl(&app);

    // 优先按 z-order 遍历（顶→底），返回第一个几何命中的窗口
    for label in &z_ordered_labels {
        if let Some(ref exclude) = exclude_label {
            if label == exclude {
                continue;
            }
        }
        if let Some(window) = app.get_webview_window(label) {
            let Ok(pos) = window.outer_position() else {
                continue;
            };
            let Ok(size) = window.outer_size() else {
                continue;
            };
            let left = pos.x as f64;
            let top = pos.y as f64;
            let right = left + size.width as f64;
            let bottom = top + size.height as f64;
            if x >= left && x < right && y >= top && y < bottom {
                return Some(label.clone());
            }
        }
    }

    // Fallback：z-order 不可用时用旧的 HashMap + is_focused 启发式
    if !z_ordered_labels.is_empty() {
        return None;
    }
    let mut hit: Option<String> = None;
    for (label, window) in app.webview_windows() {
        if let Some(ref exclude) = exclude_label {
            if &label == exclude {
                continue;
            }
        }
        let Ok(pos) = window.outer_position() else {
            continue;
        };
        let Ok(size) = window.outer_size() else {
            continue;
        };
        let left = pos.x as f64;
        let top = pos.y as f64;
        let right = left + size.width as f64;
        let bottom = top + size.height as f64;
        if x >= left && x < right && y >= top && y < bottom {
            if hit.is_none() {
                hit = Some(label);
            } else if window.is_focused().unwrap_or(false) {
                hit = Some(label);
            }
        }
    }
    hit
}

/// 返回所有 WebView 窗口的 label，按 Win32 z-order（顶→底）排序。
///
/// 用于跨窗拖拽命中测试：多个目标窗口几何重叠时，
/// 需要识别哪个窗口在视觉最顶层，而非依赖 HashMap 迭代顺序或 is_focused()。
///
/// 拖拽中源窗持有鼠标捕获和 focus，is_focused() 对目标窗无效。
/// EnumWindows 按 z-order（顶→底）枚举所有顶层窗口，过滤出 Tauri webview 窗口。
#[tauri::command]
pub fn window_z_order(app: AppHandle) -> Vec<String> {
    window_z_order_impl(&app)
}

#[cfg(windows)]
fn window_z_order_impl(app: &AppHandle) -> Vec<String> {
    use std::collections::HashMap;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    // 收集所有 Tauri webview 窗口的 HWND → label 映射
    let mut hwnd_to_label: HashMap<isize, String> = HashMap::new();
    for (label, window) in app.webview_windows() {
        // 通过 raw-window-handle 获取 Win32 HWND
        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                hwnd_to_label.insert(win32.hwnd.get() as isize, label);
            }
        }
    }

    if hwnd_to_label.is_empty() {
        return Vec::new();
    }

    // EnumWindows 按 z-order（顶→底）枚举所有顶层窗口
    let mut all_hwnds: Vec<isize> = Vec::new();

    unsafe extern "system" fn collect_hwnds(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let vec = &mut *(lparam.0 as *mut Vec<isize>);
            vec.push(hwnd.0 as isize);
        }
        BOOL(1) // TRUE = 继续枚举
    }

    unsafe {
        let ptr = &mut all_hwnds as *mut Vec<isize>;
        let _ = EnumWindows(Some(collect_hwnds), LPARAM(ptr as isize));
    }

    // 过滤出 Tauri webview 窗口，保持 z-order 顺序
    all_hwnds
        .into_iter()
        .filter_map(|hwnd| hwnd_to_label.get(&hwnd).cloned())
        .collect()
}

#[cfg(not(windows))]
fn window_z_order_impl(_app: &AppHandle) -> Vec<String> {
    Vec::new()
}

/// 独立窗口的位置和大小（物理像素），用于恢复上次窗口几何。
#[derive(serde::Deserialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 打开（或聚焦）工作区独立窗口。
///
/// Windows 要点（Tauri 官方文档 + tauri#13092/#15014）：
/// 1. 必须 `async` command 里 `build()`，禁止同步 command / run_on_main_thread 阻塞建窗
/// 2. 配置了 `additionalBrowserArgs` 时，每个子窗必须 `.data_directory(独立路径)`
/// 3. 用 `WebviewUrl::App("index.html")`，由 initialization_script 注入 workspaceId
#[tauri::command]
pub async fn open_workspace_window(
    app: AppHandle,
    workspace_id: String,
    title: String,
    handoff_json: Option<String>,
    bounds: Option<WindowBounds>,
) -> Result<String, String> {
    append_log(
        &app,
        &format!("open begin id={workspace_id} title={title}"),
    );

    if workspace_id.trim().is_empty() {
        return Err("workspace_id 不能为空".into());
    }

    if let Some(json) = handoff_json.filter(|s| !s.trim().is_empty()) {
        let path = handoff_path(&app, &workspace_id)?;
        std::fs::write(&path, json).map_err(|e| format!("写入 handoff 失败: {e}"))?;
        append_log(&app, &format!("handoff written {}", path.display()));
    }

    let label = workspace_window_label(&workspace_id);

    if let Some(existing) = app.get_webview_window(&label) {
        append_log(&app, &format!("reuse label={label}"));
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        let _ = existing.set_title(&title);
        return Ok(label);
    }

    let data_dir = webview_data_directory(&app, &label)?;
    append_log(
        &app,
        &format!("data_directory={}", data_dir.display()),
    );

    let injected = serde_json::to_string(&workspace_id)
        .map_err(|e| format!("序列化 workspace_id 失败: {e}"))?;

    let init_script = format!(
        r##"(function(){{
  try {{
    Object.defineProperty(window, "__OMNIPANEL_WORKSPACE_WINDOW__", {{
      value: {injected},
      writable: false,
      configurable: false
    }});
    console.log("[workspaceWindow:init]", {injected}, location.href);
  }} catch (e) {{
    console.error("[workspaceWindow:init]", e);
  }}
}})();"##
    );

    let app_destroy = app.clone();
    let label_destroy = label.clone();
    let ws_destroy = workspace_id.clone();

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .min_inner_size(640.0, 420.0)
        .resizable(true)
        .closable(true)
        .decorations(false)
        .focused(true)
        .visible(true)
        // 与前端 --bg / boot-splash 对齐，避免跨 DPI 时原生客户区与 WebView 表面色差形成「小灰块」
        .background_color(tauri::window::Color(26, 23, 23, 255))
        .data_directory(data_dir)
        .initialization_script(&init_script)
        .disable_drag_drop_handler()
        // Windows WebView2：关闭「保存的信息」等原生自动填充建议
        .general_autofill_enabled(false);

    if let Some(ref b) = bounds {
        builder = builder
            .inner_size(b.width, b.height)
            .position(b.x, b.y);
    } else {
        builder = builder
            .inner_size(1100.0, 720.0)
            .center();
    }

    let window = builder
        .build()
        .map_err(|e| {
            let msg = format!("创建工作区窗口失败: {e}");
            append_log(&app, &msg);
            msg
        })?;

    let _ = window.set_background_color(Some(tauri::window::Color(26, 23, 23, 255)));
    #[cfg(windows)]
    crate::webview_dpi::hook_window(&window);

    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            append_log(
                &app_destroy,
                &format!("DESTROYED label={label_destroy} id={ws_destroy}"),
            );
            let _ = app_destroy.emit(
                "omnipanel:workspace-window-destroyed",
                serde_json::json!({
                    "workspaceId": ws_destroy,
                    "label": label_destroy,
                }),
            );
        }
    });

    append_log(&app, &format!("open ok label={label}"));
    Ok(label)
}
