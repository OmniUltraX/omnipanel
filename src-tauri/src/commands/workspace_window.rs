use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// 窗口位置和大小（逻辑像素 + 可选多屏物理坐标/显示器名）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
    /// 所在显示器名称（多屏恢复时优先匹配）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_name: Option<String>,
    /// 窗口外框左上角物理像素（虚拟桌面坐标，跨 DPI/多屏更稳）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_height: Option<u32>,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowBoundsStoreFile {
    #[serde(default)]
    main: Option<WindowBounds>,
    #[serde(default)]
    workspaces: std::collections::HashMap<String, WindowBounds>,
}

fn window_bounds_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("window-bounds.json"))
}

fn read_window_bounds_store(app: &AppHandle) -> WindowBoundsStoreFile {
    let Ok(path) = window_bounds_store_path(app) else {
        return WindowBoundsStoreFile::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return WindowBoundsStoreFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_window_bounds_store(app: &AppHandle, store: &WindowBoundsStoreFile) -> Result<(), String> {
    let path = window_bounds_store_path(app)?;
    let raw = serde_json::to_string_pretty(store).map_err(|e| format!("序列化窗口几何失败: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("写入窗口几何失败: {e}"))
}

fn sanitize_bounds(bounds: &WindowBounds) -> Option<WindowBounds> {
    if !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || !bounds.x.is_finite()
        || !bounds.y.is_finite()
    {
        return None;
    }
    if bounds.width < 400.0 || bounds.height < 300.0 {
        return None;
    }
    Some(WindowBounds {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width.clamp(400.0, 10000.0),
        height: bounds.height.clamp(300.0, 10000.0),
        maximized: bounds.maximized,
        monitor_name: bounds
            .monitor_name
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        physical_x: bounds.physical_x,
        physical_y: bounds.physical_y,
        physical_width: bounds.physical_width.filter(|&w| w >= 400),
        physical_height: bounds.physical_height.filter(|&h| h >= 300),
    })
}

fn monitor_contains_point(mon: &tauri::Monitor, px: i32, py: i32) -> bool {
    let pos = mon.position();
    let size = mon.size();
    px >= pos.x
        && py >= pos.y
        && px < pos.x.saturating_add(size.width as i32)
        && py < pos.y.saturating_add(size.height as i32)
}

fn clamp_physical_to_monitor(
    px: i32,
    py: i32,
    pw: u32,
    ph: u32,
    mon: &tauri::Monitor,
) -> (i32, i32, u32, u32) {
    let pos = mon.position();
    let size = mon.size();
    let min_visible = 80i32;
    let max_x = (pos.x + size.width as i32 - min_visible).max(pos.x);
    let max_y = (pos.y + size.height as i32 - min_visible).max(pos.y);
    let x = px.clamp(pos.x, max_x);
    let y = py.clamp(pos.y, max_y);
    let w = pw.clamp(400, size.width.max(400));
    let h = ph.clamp(300, size.height.max(300));
    (x, y, w, h)
}

fn pick_target_monitor<'a>(
    app: &AppHandle,
    bounds: &WindowBounds,
    monitors: &'a [tauri::Monitor],
    px: i32,
    py: i32,
) -> Option<&'a tauri::Monitor> {
    if let Some(name) = bounds.monitor_name.as_deref() {
        if let Some(m) = monitors.iter().find(|m| m.name().map(|n| n.as_str()) == Some(name)) {
            return Some(m);
        }
    }
    if let Some(m) = monitors.iter().find(|m| monitor_contains_point(m, px, py)) {
        return Some(m);
    }
    if let Ok(Some(primary)) = app.primary_monitor() {
        let pname = primary.name().cloned();
        if let Some(name) = pname {
            if let Some(m) = monitors.iter().find(|m| m.name() == Some(&name)) {
                return Some(m);
            }
        }
    }
    monitors.first()
}

/// 按当前可用显示器解析/钳位几何：优先恢复到记忆的屏幕；显示器缺失时落到仍可见区域。
fn resolve_bounds_for_current_displays(app: &AppHandle, bounds: &WindowBounds) -> WindowBounds {
    let Ok(monitors) = app.available_monitors() else {
        return bounds.clone();
    };
    if monitors.is_empty() {
        return bounds.clone();
    }

    let scale_guess = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
        .max(0.1);

    let mut px = bounds
        .physical_x
        .unwrap_or_else(|| (bounds.x * scale_guess).round() as i32);
    let mut py = bounds
        .physical_y
        .unwrap_or_else(|| (bounds.y * scale_guess).round() as i32);
    let pw = bounds
        .physical_width
        .unwrap_or_else(|| (bounds.width * scale_guess).round() as u32)
        .max(400);
    let ph = bounds
        .physical_height
        .unwrap_or_else(|| (bounds.height * scale_guess).round() as u32)
        .max(300);

    let Some(target) = pick_target_monitor(app, bounds, &monitors, px, py) else {
        return bounds.clone();
    };

    let on_any = monitors.iter().any(|m| monitor_contains_point(m, px, py));
    if !on_any {
        // 原屏幕已断开：落到目标屏工作区左上附近
        px = target.position().x + 40;
        py = target.position().y + 40;
    } else if let Some(name) = bounds.monitor_name.as_deref() {
        // 记忆屏仍在但当前物理点在别的屏：按相对偏移迁回记忆屏
        if target.name().map(|n| n.as_str()) == Some(name) {
            if let Some(from) = monitors.iter().find(|m| monitor_contains_point(m, px, py)) {
                if from.name() != target.name() {
                    let rel_x = px - from.position().x;
                    let rel_y = py - from.position().y;
                    px = target.position().x + rel_x;
                    py = target.position().y + rel_y;
                }
            }
        }
    }

    let (cx, cy, cw, ch) = clamp_physical_to_monitor(px, py, pw, ph, target);
    let scale = target.scale_factor().max(0.1);
    WindowBounds {
        x: cx as f64 / scale,
        y: cy as f64 / scale,
        width: cw as f64 / scale,
        height: ch as f64 / scale,
        maximized: bounds.maximized,
        monitor_name: target.name().cloned(),
        physical_x: Some(cx),
        physical_y: Some(cy),
        physical_width: Some(cw),
        physical_height: Some(ch),
    }
}

const SPLASH_LABEL: &str = "splash";
/// 启动阶段固定小窗尺寸，就绪后再放大到记忆几何
const SPLASH_WIDTH: f64 = 520.0;
const SPLASH_HEIGHT: f64 = 420.0;
const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 800.0;

/// 只摆普通几何（位置/尺寸）。最大化单独处理：Windows 上对隐藏窗 maximize 常会强制显示。
fn apply_bounds_geometry(window: &tauri::WebviewWindow, bounds: &WindowBounds) {
    let _ = window.unmaximize();
    if let (Some(px), Some(py)) = (bounds.physical_x, bounds.physical_y) {
        let _ = window.set_position(tauri::PhysicalPosition::new(px, py));
    } else {
        let _ = window.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y));
    }
    if let (Some(pw), Some(ph)) = (bounds.physical_width, bounds.physical_height) {
        let _ = window.set_size(tauri::PhysicalSize::new(pw, ph));
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(bounds.width, bounds.height));
    }
}

fn apply_bounds_to_window(window: &tauri::WebviewWindow, bounds: &WindowBounds) {
    apply_bounds_geometry(window, bounds);
    if bounds.maximized {
        let _ = window.maximize();
    }
}

/// 冷启动摆位：记下是否要最大化，但此刻不 maximize（避免隐藏窗被系统强行显示）。
fn apply_startup_bounds(window: &tauri::WebviewWindow, bounds: &WindowBounds) {
    MAIN_PENDING_MAXIMIZE.store(bounds.maximized, Ordering::SeqCst);
    apply_bounds_geometry(window, bounds);
}

static MAIN_PENDING_MAXIMIZE: AtomicBool = AtomicBool::new(false);
/// 小尺寸 splash 窗已显示给用户
static MAIN_SPLASH_SHOWN: AtomicBool = AtomicBool::new(false);
/// 已放大到正式主窗几何
static MAIN_EXPANDED: AtomicBool = AtomicBool::new(false);

/// 历史双窗 splash 交接用；现已单窗启动，始终允许正常退出。
pub fn should_prevent_exit_for_splash_handoff(_app: &AppHandle) -> bool {
    false
}

fn pick_target_monitor_for_splash<'a>(
    app: &AppHandle,
    bounds: Option<&WindowBounds>,
    monitors: &'a [tauri::Monitor],
) -> Option<&'a tauri::Monitor> {
    if let Some(b) = bounds {
        let scale_guess = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0)
            .max(0.1);
        let px = b
            .physical_x
            .unwrap_or_else(|| (b.x * scale_guess).round() as i32);
        let py = b
            .physical_y
            .unwrap_or_else(|| (b.y * scale_guess).round() as i32);
        return pick_target_monitor(app, b, monitors, px, py);
    }
    if let Ok(cursor) = app.cursor_position() {
        let cx = cursor.x.round() as i32;
        let cy = cursor.y.round() as i32;
        if let Some(m) = monitors.iter().find(|m| monitor_contains_point(m, cx, cy)) {
            return Some(m);
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .and_then(|p| {
            let name = p.name().cloned();
            name.and_then(|n| monitors.iter().find(|m| m.name() == Some(&n)))
        })
        .or_else(|| monitors.first())
}

fn center_rect_on_monitor(mon: &tauri::Monitor, width_logical: f64, height_logical: f64) -> (i32, i32) {
    let scale = mon.scale_factor().max(0.1);
    let ww = (width_logical * scale).round() as i32;
    let wh = (height_logical * scale).round() as i32;
    let mx = mon.position().x;
    let my = mon.position().y;
    let mw = mon.size().width as i32;
    let mh = mon.size().height as i32;
    let x = mx + ((mw - ww) / 2).max(0);
    let y = my + ((mh - wh) / 2).max(0);
    (x, y)
}

/// 无记忆几何时：尽量落在光标所在屏并居中（避免固定落到主屏）。
fn center_window_on_cursor_monitor(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else {
        let _ = window.center();
        return;
    };
    let Ok(monitors) = app.available_monitors() else {
        let _ = window.center();
        return;
    };
    let cx = cursor.x.round() as i32;
    let cy = cursor.y.round() as i32;
    let target = monitors
        .iter()
        .find(|m| monitor_contains_point(m, cx, cy))
        .or_else(|| {
            app.primary_monitor()
                .ok()
                .flatten()
                .and_then(|p| {
                    let name = p.name().cloned();
                    name.and_then(|n| monitors.iter().find(|m| m.name() == Some(&n)))
                })
        })
        .or_else(|| monitors.first());

    let Some(mon) = target else {
        let _ = window.center();
        return;
    };
    let Ok(size) = window.outer_size() else {
        let _ = window.center();
        return;
    };
    let mx = mon.position().x;
    let my = mon.position().y;
    let mw = mon.size().width as i32;
    let mh = mon.size().height as i32;
    let ww = size.width as i32;
    let wh = size.height as i32;
    let x = mx + ((mw - ww) / 2).max(0);
    let y = my + ((mh - wh) / 2).max(0);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

fn splash_center_position(app: &AppHandle, resolved: Option<&WindowBounds>) -> (i32, i32) {
    let monitors = app.available_monitors().unwrap_or_default();
    let target = pick_target_monitor_for_splash(app, resolved, &monitors);
    target
        .map(|m| center_rect_on_monitor(m, SPLASH_WIDTH, SPLASH_HEIGHT))
        .unwrap_or((80, 80))
}

/// 创建后：记下 maximize，以 splash 尺寸在目标屏 show 强制 WebView 加载。
///
/// 注意：不要用 (-32000,-32000) 屏外坐标。Windows 会把任务栏按钮绑到
/// 首次 show 所在的显示器（通常是主屏），导致副屏窗口最小化动画/按钮跑到主屏。
fn place_main_for_boot(app: &AppHandle, window: &tauri::WebviewWindow, resolved: Option<&WindowBounds>) {
    let _ = window.set_background_color(Some(tauri::window::Color(14, 20, 25, 255)));
    if let Some(b) = resolved {
        MAIN_PENDING_MAXIMIZE.store(b.maximized, Ordering::SeqCst);
    } else {
        MAIN_PENDING_MAXIMIZE.store(false, Ordering::SeqCst);
    }
    let (pos_x, pos_y) = splash_center_position(app, resolved);
    let _ = window.set_resizable(false);
    // 加载阶段隐藏任务栏按钮；露出 splash 后再打开，确保按钮落在当前屏
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_size(tauri::LogicalSize::new(SPLASH_WIDTH, SPLASH_HEIGHT));
    let _ = window.set_position(tauri::PhysicalPosition::new(pos_x, pos_y));
    let _ = window.show();
}

/// 任务栏按钮按当前窗口所在屏重新挂接（先藏再显）。
fn rebind_taskbar_to_current_monitor(window: &tauri::WebviewWindow) {
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_skip_taskbar(false);
}

/// 显示固定小尺寸 splash 窗（SplashScreen 首帧后调用）。
fn show_splash_window(app: &AppHandle) {
    if MAIN_EXPANDED.load(Ordering::SeqCst) {
        return;
    }
    if MAIN_SPLASH_SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        MAIN_SPLASH_SHOWN.store(false, Ordering::SeqCst);
        return;
    };
    let resolved = resolved_main_bounds(app);
    let (pos_x, pos_y) = splash_center_position(app, resolved.as_ref());

    let _ = window.set_background_color(Some(tauri::window::Color(14, 20, 25, 255)));
    let _ = window.set_resizable(false);
    let _ = window.set_size(tauri::LogicalSize::new(SPLASH_WIDTH, SPLASH_HEIGHT));
    let _ = window.set_position(tauri::PhysicalPosition::new(pos_x, pos_y));
    let _ = window.unminimize();
    let _ = window.show();
    // 位置落稳后再挂任务栏，避免按钮粘在主屏
    rebind_taskbar_to_current_monitor(&window);
    let _ = window.set_focus();
}

/// 从小尺寸放大到正式主窗几何。
fn expand_main_window(app: &AppHandle) {
    if MAIN_EXPANDED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        MAIN_EXPANDED.store(false, Ordering::SeqCst);
        return;
    };
    MAIN_SPLASH_SHOWN.store(true, Ordering::SeqCst);

    let _ = window.set_background_color(Some(tauri::window::Color(14, 20, 25, 255)));
    let _ = window.set_resizable(true);

    if let Some(bounds) = resolved_main_bounds(app) {
        apply_startup_bounds(&window, &bounds);
    } else {
        MAIN_PENDING_MAXIMIZE.store(false, Ordering::SeqCst);
        let _ = window.set_size(tauri::LogicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT));
        center_window_on_cursor_monitor(app, &window);
    }

    let want_max = MAIN_PENDING_MAXIMIZE.load(Ordering::SeqCst);
    let _ = window.unminimize();
    let _ = window.show();
    if want_max {
        let _ = window.maximize();
    }
    rebind_taskbar_to_current_monitor(&window);
    let _ = window.set_focus();
}

/// 前端 SplashScreen 已绘制：露出固定小尺寸启动窗。
#[tauri::command]
pub fn main_window_show_splash(app: AppHandle) {
    show_splash_window(&app);
}

/// 启动完成 / 登录页：放大到正式主窗尺寸。
#[tauri::command]
pub fn main_window_reveal(app: AppHandle) {
    expand_main_window(&app);
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootProgressPayload {
    step: u32,
    total_steps: u32,
    log: String,
}

/// 兼容旧双窗协议；单窗启动时进度由 Bootstrap 本地 SplashScreen 直接驱动。
#[tauri::command]
pub fn boot_splash_progress(app: AppHandle, step: u32, total_steps: u32, log: String) {
    let payload = BootProgressPayload {
        step,
        total_steps,
        log,
    };
    let _ = app.emit("omnipanel:boot-progress", &payload);
}

fn resolved_main_bounds(app: &AppHandle) -> Option<WindowBounds> {
    read_window_bounds_store(app)
        .main
        .and_then(|b| sanitize_bounds(&b))
        .map(|b| resolve_bounds_for_current_displays(app, &b))
}

/// 单窗启动：先以 splash 尺寸在目标屏加载，前端再露出 splash → 完成后放大。
pub fn create_main_window(app: &AppHandle) -> Result<(), String> {
    MAIN_SPLASH_SHOWN.store(false, Ordering::SeqCst);
    MAIN_EXPANDED.store(false, Ordering::SeqCst);
    MAIN_PENDING_MAXIMIZE.store(false, Ordering::SeqCst);

    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.close();
    }

    let resolved = resolved_main_bounds(app);

    if let Some(window) = app.get_webview_window("main") {
        place_main_for_boot(app, &window, resolved.as_ref());
        schedule_main_window_reveal_fallback(app.clone());
        return Ok(());
    }

    let window_cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| "缺少 main 窗口配置".to_string())?;

    let (pos_x, pos_y) = splash_center_position(app, resolved.as_ref());
    let scale = app
        .available_monitors()
        .ok()
        .and_then(|ms| {
            pick_target_monitor_for_splash(app, resolved.as_ref(), &ms).map(|m| m.scale_factor())
        })
        .unwrap_or(1.0)
        .max(0.1);
    let logical_x = pos_x as f64 / scale;
    let logical_y = pos_y as f64 / scale;

    if let Some(ref b) = resolved {
        MAIN_PENDING_MAXIMIZE.store(b.maximized, Ordering::SeqCst);
    }

    let window = WebviewWindowBuilder::from_config(app, &window_cfg)
        .map_err(|e| format!("主窗 from_config 失败: {e}"))?
        .inner_size(SPLASH_WIDTH, SPLASH_HEIGHT)
        .position(logical_x, logical_y)
        .visible(false)
        .focused(false)
        .resizable(false)
        .background_color(tauri::window::Color(14, 20, 25, 255))
        .build()
        .map_err(|e| format!("创建主窗口失败: {e}"))?;

    place_main_for_boot(app, &window, resolved.as_ref());
    schedule_main_window_reveal_fallback(app.clone());

    Ok(())
}

/// 超时兜底：先露小窗，再放大，避免一直黑屏。
fn schedule_main_window_reveal_fallback(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        if !MAIN_SPLASH_SHOWN.load(Ordering::SeqCst) && !MAIN_EXPANDED.load(Ordering::SeqCst) {
            show_splash_window(&app);
        }
        std::thread::sleep(Duration::from_secs(10));
        if !MAIN_EXPANDED.load(Ordering::SeqCst) {
            expand_main_window(&app);
        }
    });
}

/// 读取主窗口上次几何。
#[tauri::command]
pub fn window_bounds_get_main(app: AppHandle) -> Result<Option<WindowBounds>, String> {
    Ok(read_window_bounds_store(&app).main)
}

/// 写入主窗口几何。
#[tauri::command]
pub fn window_bounds_set_main(app: AppHandle, bounds: WindowBounds) -> Result<(), String> {
    let Some(bounds) = sanitize_bounds(&bounds) else {
        return Ok(());
    };
    let mut store = read_window_bounds_store(&app);
    store.main = Some(bounds);
    write_window_bounds_store(&app, &store)
}

/// 读取工作区独立窗口上次几何。
#[tauri::command]
pub fn window_bounds_get_workspace(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<WindowBounds>, String> {
    if workspace_id.trim().is_empty() {
        return Ok(None);
    }
    Ok(read_window_bounds_store(&app)
        .workspaces
        .get(&workspace_id)
        .cloned())
}

/// 写入工作区独立窗口几何。
#[tauri::command]
pub fn window_bounds_set_workspace(
    app: AppHandle,
    workspace_id: String,
    bounds: WindowBounds,
) -> Result<(), String> {
    if workspace_id.trim().is_empty() {
        return Ok(());
    }
    let Some(bounds) = sanitize_bounds(&bounds) else {
        return Ok(());
    };
    let mut store = read_window_bounds_store(&app);
    store.workspaces.insert(workspace_id, bounds);
    write_window_bounds_store(&app, &store)
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

    // 优先用调用方传入的 bounds；否则读持久化；再否则默认居中
    let restored = bounds
        .as_ref()
        .and_then(sanitize_bounds)
        .or_else(|| {
            read_window_bounds_store(&app)
                .workspaces
                .get(&workspace_id)
                .and_then(sanitize_bounds)
        })
        .map(|b| resolve_bounds_for_current_displays(&app, &b));

    if let Some(ref b) = restored {
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

    // 用物理坐标再落一次，确保多屏/混合 DPI 下回到记忆屏幕
    if let Some(ref b) = restored {
        apply_bounds_to_window(&window, b);
    }

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
