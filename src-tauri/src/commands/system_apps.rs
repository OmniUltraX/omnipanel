//! 系统应用枚举与启动（快捷面板 plain 搜索）。
//!
//! Windows：开始菜单 `.lnk` + `App Paths` 注册表。
//! 其它平台：暂返回空列表。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_APPS: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppEntry {
    /// 稳定 id（路径规范化）
    pub id: String,
    /// 展示名（快捷方式名 / 可执行名）
    pub name: String,
    /// 启动路径（.lnk / .exe）
    pub path: String,
    /// `start-menu` | `app-paths`
    pub source: String,
}

struct AppCache {
    fetched_at: Instant,
    apps: Vec<SystemAppEntry>,
}

static CACHE: Mutex<Option<AppCache>> = Mutex::new(None);

fn normalize_id(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

fn display_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn should_skip_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    const BLOCK: &[&str] = &[
        "uninstall",
        "卸载",
        "remove",
        "help",
        "帮助",
        "read me",
        "readme",
        "release notes",
        "eula",
        "license",
    ];
    BLOCK.iter().any(|b| lower.contains(b))
}

fn source_rank(source: &str) -> u8 {
    match source {
        "start-menu" => 2,
        "app-paths" => 1,
        _ => 0,
    }
}

/// 同目标冲突时是否用 candidate 替换 existing。
/// 优先开始菜单快捷方式（展示名 + .lnk），而不是 App Paths 的 exe。
fn should_replace(existing: &SystemAppEntry, candidate: &SystemAppEntry) -> bool {
    let er = source_rank(&existing.source);
    let cr = source_rank(&candidate.source);
    if cr != er {
        return cr > er;
    }
    let e_lnk = existing.path.to_lowercase().ends_with(".lnk");
    let c_lnk = candidate.path.to_lowercase().ends_with(".lnk");
    if c_lnk != e_lnk {
        return c_lnk;
    }
    // 同来源：更友好的展示名（更长通常是「Google Chrome」而非「chrome」）
    candidate.name.len() > existing.name.len()
}

/// 解析去重键：`.lnk` → 真实目标 exe；其它 → 自身路径。
fn resolve_target_key(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "lnk" {
        if let Some(target) = resolve_shortcut_target(path) {
            return normalize_id(&target.to_string_lossy());
        }
    }
    normalize_id(&path.to_string_lossy())
}

#[cfg(windows)]
fn resolve_shortcut_target(lnk: &Path) -> Option<PathBuf> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        // Tauri 进程通常已初始化 COM；重复调用返回 S_FALSE，可忽略
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        let path = HSTRING::from(lnk.as_os_str());
        persist.Load(&path, STGM_READ).ok()?;

        let mut buf = vec![0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if end == 0 {
            return None;
        }
        let target = String::from_utf16_lossy(&buf[..end]);
        let trimmed = target.trim().trim_matches('"');
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    }
}

#[cfg(not(windows))]
fn resolve_shortcut_target(_lnk: &Path) -> Option<PathBuf> {
    None
}

/// `map` 的 key 为解析后的目标 exe（规范化路径），value 为最终展示/启动条目。
fn push_app(
    map: &mut HashMap<String, SystemAppEntry>,
    name: String,
    path: PathBuf,
    source: &str,
) {
    let name = name.trim().to_string();
    if name.is_empty() || should_skip_name(&name) {
        return;
    }
    let path_str = path.to_string_lossy().trim().to_string();
    if path_str.is_empty() {
        return;
    }
    let target_key = resolve_target_key(&path);
    if target_key.is_empty() {
        return;
    }
    let entry = SystemAppEntry {
        id: normalize_id(&path_str),
        name,
        path: path_str,
        source: source.to_string(),
    };
    match map.get(&target_key) {
        Some(existing) if !should_replace(existing, &entry) => {}
        _ => {
            map.insert(target_key, entry);
        }
    }
}

#[cfg(windows)]
fn collect_start_menu_apps(map: &mut HashMap<String, SystemAppEntry>) {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    for root in roots {
        visit_start_menu_dir(&root, map);
    }
}

#[cfg(windows)]
fn visit_start_menu_dir(dir: &Path, map: &mut HashMap<String, SystemAppEntry>) {
    if map.len() >= MAX_APPS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if map.len() >= MAX_APPS {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            visit_start_menu_dir(&path, map);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext != "lnk" && ext != "exe" {
            continue;
        }
        let name = display_name_from_path(&path);
        push_app(map, name, path, "start-menu");
    }
}

#[cfg(windows)]
fn collect_app_paths(map: &mut HashMap<String, SystemAppEntry>) {
    use winreg::enums::*;
    use winreg::RegKey;

    const SUBKEYS: &[&str] = &[
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ];

    let roots = [
        RegKey::predef(HKEY_LOCAL_MACHINE),
        RegKey::predef(HKEY_CURRENT_USER),
    ];

    for root in roots {
        for sub in SUBKEYS {
            let Ok(key) = root.open_subkey(sub) else {
                continue;
            };
            for name in key.enum_keys().filter_map(Result::ok) {
                if map.len() >= MAX_APPS {
                    return;
                }
                let Ok(child) = key.open_subkey(&name) else {
                    continue;
                };
                // 默认值为可执行完整路径
                let path: String = child.get_value("").unwrap_or_default();
                let path = path.trim().trim_matches('"');
                if path.is_empty() {
                    continue;
                }
                let pb = PathBuf::from(path);
                if !pb.exists() {
                    continue;
                }
                let display = display_name_from_path(Path::new(&name));
                push_app(map, display, pb, "app-paths");
            }
        }
    }
}

#[cfg(windows)]
fn collect_system_apps_impl() -> Vec<SystemAppEntry> {
    let mut map = HashMap::new();
    // 先扫开始菜单（.lnk），再补 App Paths；同目标 exe 保留快捷方式条目
    collect_start_menu_apps(&mut map);
    collect_app_paths(&mut map);
    let mut apps: Vec<_> = map.into_values().collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(not(windows))]
fn collect_system_apps_impl() -> Vec<SystemAppEntry> {
    Vec::new()
}

fn get_cached_apps(force_refresh: bool) -> Vec<SystemAppEntry> {
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if !force_refresh {
            if let Some(cache) = guard.as_ref() {
                if cache.fetched_at.elapsed() < CACHE_TTL {
                    return cache.apps.clone();
                }
            }
        }
    }

    let apps = collect_system_apps_impl();
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(AppCache {
            fetched_at: Instant::now(),
            apps: apps.clone(),
        });
    }
    apps
}

fn find_cached_by_id(id: &str) -> Option<SystemAppEntry> {
    let needle = normalize_id(id);
    let apps = get_cached_apps(false);
    apps.into_iter().find(|a| a.id == needle || normalize_id(&a.path) == needle)
}

/// 进程内图标 data URL 缓存（按 app id）。
static ICON_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 批量获取应用图标（data URL）。仅解析缓存列表内的 id；失败项省略。
#[tauri::command]
pub fn get_system_app_icons(ids: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }

    let mut missing: Vec<(String, String)> = Vec::new();
    {
        let cache = ICON_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        for raw in ids {
            let id = normalize_id(raw.trim());
            if id.is_empty() {
                continue;
            }
            if let Some(cached) = cache.get(&id) {
                if let Some(url) = cached {
                    out.insert(id, url.clone());
                }
                continue;
            }
            if let Some(entry) = find_cached_by_id(&id) {
                missing.push((id, entry.path));
            }
        }
    }

    for (id, path) in missing {
        let url = extract_file_icon_data_url(&path);
        if let Ok(mut cache) = ICON_CACHE.lock() {
            cache.insert(id.clone(), url.clone());
        }
        if let Some(url) = url {
            out.insert(id, url);
        }
    }

    Ok(out)
}

#[cfg(windows)]
fn extract_file_icon_data_url(path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;

    use base64::Engine;
    use image::RgbaImage;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut shfi = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            Default::default(),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ok == 0 || shfi.hIcon.is_invalid() {
            return None;
        }
        let hicon = shfi.hIcon;

        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return None;
        }

        let hbmp = if !icon_info.hbmColor.is_invalid() {
            icon_info.hbmColor
        } else {
            icon_info.hbmMask
        };

        let mut bm = BITMAP::default();
        if GetObjectW(
            HGDIOBJ(hbmp.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut bm as *mut BITMAP).cast()),
        ) == 0
        {
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
            }
            let _ = DestroyIcon(hicon);
            return None;
        }

        let width = bm.bmWidth;
        let height = bm.bmHeight.abs();
        if width <= 0 || height <= 0 || width > 256 || height > 256 {
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
            }
            let _ = DestroyIcon(hicon);
            return None;
        }

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
            }
            let _ = DestroyIcon(hicon);
            return None;
        }

        let copied = GetDIBits(
            hdc,
            hbmp,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(hdc);

        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
        }
        let _ = DestroyIcon(hicon);

        if copied == 0 {
            return None;
        }

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        let img = RgbaImage::from_raw(width as u32, height as u32, pixels)?;
        let mut png = Vec::new();
        {
            let encoder = image::codecs::png::PngEncoder::new(&mut png);
            use image::ImageEncoder;
            encoder
                .write_image(
                    img.as_raw(),
                    img.width(),
                    img.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .ok()?;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Some(format!("data:image/png;base64,{b64}"))
    }
}

#[cfg(not(windows))]
fn extract_file_icon_data_url(_path: &str) -> Option<String> {
    None
}

/// 列出本机可启动应用（带进程内缓存）。
#[tauri::command]
pub fn list_system_apps(force_refresh: Option<bool>) -> Result<Vec<SystemAppEntry>, String> {
    Ok(get_cached_apps(force_refresh.unwrap_or(false)))
}

/// 启动系统应用（仅允许缓存列表内的路径）。
#[tauri::command]
pub fn launch_system_app(id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("应用 id 为空".to_string());
    }
    let entry = find_cached_by_id(id).ok_or_else(|| "未找到该应用，请刷新后重试".to_string())?;
    launch_path(&entry.path)
}

#[cfg(windows)]
fn launch_path(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `start "" <path>` 可正确打开 .lnk / .exe（含空格路径）
    let status = Command::new("cmd")
        .args(["/C", "start", "", path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;
    let _ = status;
    Ok(())
}

#[cfg(not(windows))]
fn launch_path(_path: &str) -> Result<(), String> {
    Err("当前平台暂不支持启动系统应用".to_string())
}
