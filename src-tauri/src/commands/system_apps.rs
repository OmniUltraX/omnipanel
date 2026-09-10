//! 系统应用枚举与启动（快捷面板 plain 搜索）。
//!
//! Windows：开始菜单 `.lnk` + `App Paths` + `shell:AppsFolder`（含 UWP）。
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
    /// `start-menu` | `app-paths` | `apps-folder`
    pub source: String,
    /// 搜索别名（如 calc、notepad）；合并去重时保留被覆盖条目的可搜名
    #[serde(default)]
    pub aliases: Vec<String>,
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
        // 开始菜单快捷方式展示名最好；AppsFolder 覆盖 UWP；App Paths 兜底
        "start-menu" => 3,
        "apps-folder" => 2,
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

#[cfg(windows)]
fn resolve_shortcut_target(lnk: &Path) -> Option<PathBuf> {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        IPersistFile, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{HSTRING, Interface};

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

fn push_alias(aliases: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    let lower = trimmed.to_lowercase();
    if aliases
        .iter()
        .any(|a| a.eq_ignore_ascii_case(&lower) || a.to_lowercase() == lower)
    {
        return;
    }
    aliases.push(trimmed.to_string());
}

/// 常见中英文 / 可执行名互搜（合并后只留「计算器」时仍能用 calc 命中）。
fn known_aliases_for(name: &str) -> &'static [&'static str] {
    let key = name.trim().to_lowercase();
    match key.as_str() {
        "计算器" | "calculator" | "calc" => &["calc", "calculator", "计算器"],
        "记事本" | "notepad" => &["notepad", "note", "记事本"],
        "画图" | "paint" | "mspaint" => &["mspaint", "paint", "画图"],
        "命令提示符" | "command prompt" | "cmd" => &["cmd", "command", "命令提示符"],
        "windows powershell" | "powershell" | "pwsh" => &["powershell", "pwsh"],
        "终端" | "terminal" | "windows terminal" => {
            &["wt", "terminal", "windows terminal", "终端"]
        }
        "资源管理器" | "file explorer" | "explorer" => {
            &["explorer", "file explorer", "资源管理器"]
        }
        _ => &[],
    }
}

fn seed_aliases(entry: &mut SystemAppEntry, path: &Path, target: Option<&Path>) {
    push_alias(&mut entry.aliases, &display_name_from_path(path));
    if let Some(t) = target {
        push_alias(&mut entry.aliases, &display_name_from_path(t));
    }
    for a in known_aliases_for(&entry.name) {
        push_alias(&mut entry.aliases, a);
    }
    // 别名命中 known 表时再扩一轮（如 name=计算器 → calc → 再补 calculator）
    let snapshot: Vec<String> = entry.aliases.clone();
    for a in snapshot {
        for k in known_aliases_for(&a) {
            push_alias(&mut entry.aliases, k);
        }
    }
    // 展示名本身不必留在 aliases
    entry
        .aliases
        .retain(|a| !a.eq_ignore_ascii_case(&entry.name));
}

fn absorb_entry(into: &mut SystemAppEntry, other: &SystemAppEntry) {
    push_alias(&mut into.aliases, &other.name);
    for a in &other.aliases {
        push_alias(&mut into.aliases, a);
    }
    for a in known_aliases_for(&other.name) {
        push_alias(&mut into.aliases, a);
    }
    into.aliases.retain(|a| !a.eq_ignore_ascii_case(&into.name));
}

fn merge_into_map(
    map: &mut HashMap<String, SystemAppEntry>,
    target_key: String,
    entry: SystemAppEntry,
) {
    match map.remove(&target_key) {
        Some(existing) => {
            if should_replace(&existing, &entry) {
                let mut kept = entry;
                absorb_entry(&mut kept, &existing);
                map.insert(target_key, kept);
            } else {
                let mut kept = existing;
                absorb_entry(&mut kept, &entry);
                map.insert(target_key, kept);
            }
        }
        None => {
            map.insert(target_key, entry);
        }
    }
}

fn seed_apps_folder_aliases(entry: &mut SystemAppEntry, aumid: &str) {
    for a in known_aliases_for(&entry.name) {
        push_alias(&mut entry.aliases, a);
    }
    // Microsoft.WindowsCalculator_8wekyb3d8bbwe!App → WindowsCalculator / Calculator
    let package = aumid.split('!').next().unwrap_or(aumid);
    let family = package.split('_').next().unwrap_or(package);
    if let Some(short) = family.rsplit('.').next() {
        push_alias(&mut entry.aliases, short);
        // WindowsCalculator → 再跑 known（若表里有）
        for a in known_aliases_for(short) {
            push_alias(&mut entry.aliases, a);
        }
    }
    let snapshot: Vec<String> = entry.aliases.clone();
    for a in snapshot {
        for k in known_aliases_for(&a) {
            push_alias(&mut entry.aliases, k);
        }
    }
    entry
        .aliases
        .retain(|a| !a.eq_ignore_ascii_case(&entry.name));
}

/// 同显示名再合并一轮（AppsFolder 与开始菜单/App Paths 目标键不同但名字相同）。
fn collapse_by_display_name(apps: Vec<SystemAppEntry>) -> Vec<SystemAppEntry> {
    let mut by_name: HashMap<String, SystemAppEntry> = HashMap::new();
    for app in apps {
        let key = app.name.to_lowercase();
        match by_name.remove(&key) {
            Some(existing) => {
                if should_replace(&existing, &app) {
                    let mut kept = app;
                    absorb_entry(&mut kept, &existing);
                    by_name.insert(key, kept);
                } else {
                    let mut kept = existing;
                    absorb_entry(&mut kept, &app);
                    by_name.insert(key, kept);
                }
            }
            None => {
                by_name.insert(key, app);
            }
        }
    }
    by_name.into_values().collect()
}

/// `map` 的 key 为解析后的目标 exe（规范化路径），value 为最终展示/启动条目。
fn push_app(map: &mut HashMap<String, SystemAppEntry>, name: String, path: PathBuf, source: &str) {
    let name = name.trim().to_string();
    if name.is_empty() || should_skip_name(&name) {
        return;
    }
    let path_str = path.to_string_lossy().trim().to_string();
    if path_str.is_empty() {
        return;
    }
    let target = if path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("lnk")
    {
        resolve_shortcut_target(&path)
    } else {
        None
    };
    let target_key = target
        .as_ref()
        .map(|t| normalize_id(&t.to_string_lossy()))
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| normalize_id(&path_str));
    if target_key.is_empty() {
        return;
    }

    let mut entry = SystemAppEntry {
        id: normalize_id(&path_str),
        name,
        path: path_str,
        source: source.to_string(),
        aliases: Vec::new(),
    };
    seed_aliases(&mut entry, &path, target.as_deref());
    merge_into_map(map, target_key, entry);
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
    use winreg::RegKey;
    use winreg::enums::*;

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
fn collect_apps_folder(map: &mut HashMap<String, SystemAppEntry>) {
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree};
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, SHCreateItemFromParsingName,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };
    use windows::core::{GUID, HSTRING, Interface, PCWSTR};

    // System.AppUserModel.ID
    const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    unsafe fn take_pwstr(p: windows::core::PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let folder_name = HSTRING::from("shell:AppsFolder");
        let folder: IShellItem = match SHCreateItemFromParsingName::<_, _, IShellItem>(
            PCWSTR(folder_name.as_ptr()),
            None::<&_>,
        ) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("打开 shell:AppsFolder 失败: {e}");
                return;
            }
        };
        let enumerator: IEnumShellItems = match folder.BindToHandler(None, &BHID_EnumItems) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("枚举 AppsFolder 失败: {e}");
                return;
            }
        };

        loop {
            if map.len() >= MAX_APPS {
                break;
            }
            let mut slot: [Option<IShellItem>; 1] = [None];
            let mut fetched: u32 = 0;
            // S_FALSE（枚举结束）在 windows-rs 里表现为 Err，用 fetched 判断
            let _ = enumerator.Next(&mut slot, Some(&mut fetched as *mut u32));
            if fetched == 0 {
                break;
            }
            let Some(item) = slot[0].take() else {
                break;
            };

            let display = match item.GetDisplayName(SIGDN_NORMALDISPLAY) {
                Ok(p) => take_pwstr(p),
                Err(_) => continue,
            };
            if display.trim().is_empty() || should_skip_name(&display) {
                continue;
            }

            let mut aumid = String::new();
            if let Ok(item2) = item.cast::<IShellItem2>() {
                if let Ok(p) = item2.GetString(&PKEY_APP_USER_MODEL_ID as *const _) {
                    aumid = take_pwstr(p);
                }
            }
            if aumid.is_empty() {
                if let Ok(p) = item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) {
                    aumid = take_pwstr(p);
                }
            }
            aumid = aumid.trim().to_string();
            if aumid.is_empty() {
                continue;
            }

            let launch = format!("shell:AppsFolder\\{aumid}");
            let target_key = format!("appsfolder:{}", aumid.to_lowercase());
            let mut entry = SystemAppEntry {
                id: normalize_id(&launch),
                name: display,
                path: launch,
                source: "apps-folder".to_string(),
                aliases: Vec::new(),
            };
            seed_apps_folder_aliases(&mut entry, &aumid);
            merge_into_map(map, target_key, entry);
        }
    }
}

#[cfg(windows)]
fn collect_system_apps_impl() -> Vec<SystemAppEntry> {
    let mut map = HashMap::new();
    // 开始菜单 → AppsFolder(UWP) → App Paths；再按显示名塌缩
    collect_start_menu_apps(&mut map);
    collect_apps_folder(&mut map);
    collect_app_paths(&mut map);
    let mut apps = collapse_by_display_name(map.into_values().collect());
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
    apps.into_iter()
        .find(|a| a.id == needle || normalize_id(&a.path) == needle)
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
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
        DeleteObject, GetDIBits, GetObjectW, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};
    use windows::core::PCWSTR;

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
    if let Some(aumid) = path
        .strip_prefix("shell:AppsFolder\\")
        .or_else(|| path.strip_prefix("shell:AppsFolder/"))
    {
        return launch_apps_folder_app(aumid);
    }

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

#[cfg(windows)]
fn launch_apps_folder_app(aumid: &str) -> Result<(), String> {
    use windows::Win32::System::Com::{
        CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    };
    use windows::Win32::UI::Shell::{
        AO_NONE, ApplicationActivationManager, IApplicationActivationManager,
    };
    use windows::core::{HSTRING, PCWSTR};

    let aumid = aumid.trim();
    if aumid.is_empty() {
        return Err("AppID 为空".to_string());
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if let Ok(mgr) = CoCreateInstance::<_, IApplicationActivationManager>(
            &ApplicationActivationManager,
            None,
            CLSCTX_LOCAL_SERVER,
        ) {
            let id = HSTRING::from(aumid);
            if mgr
                .ActivateApplication(&id, PCWSTR::null(), AO_NONE)
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    // 回退：explorer 打开 AppsFolder 项（兼容部分 AutoGenerated AppID）
    std::process::Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{aumid}"))
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_path(_path: &str) -> Result<(), String> {
    Err("当前平台暂不支持启动系统应用".to_string())
}
