//! Windows Everything IPC：先试命名管道，失败再 WM_COPYDATA。不链接 Everything64.dll。

use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, LRESULT, WPARAM,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadFile, WriteFile,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, WaitNamedPipeW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW, GWLP_USERDATA,
    GetWindowLongPtrW, PM_REMOVE, PeekMessageW, RegisterClassExW, SendMessageW, SetWindowLongPtrW,
    TranslateMessage, UnregisterClassW, WM_COPYDATA, WM_NCCREATE, WNDCLASSEXW,
};

use crate::ipc::{
    QUERY2W, QUERYW, build_query2, build_queryw, hits_look_valid, parse_list2, parse_listw,
    strip_pipe_length_prefix,
};
use crate::{EverythingError, EverythingHit};

const PIPE_NAMES: &[&str] = &[
    r"\\.\PIPE\Everything IPC",
    r"\\.\PIPE\Everything IPC (1.5a)",
];
const EVERYTHING_WNDCLASS: &str = "EVERYTHING_TASKBAR_NOTIFICATION";
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const PIPE_READMODE_MESSAGE: u32 = 0x0000_0002;
const HWND_MESSAGE: HWND = -3isize as HWND;

#[repr(C)]
struct CopyDataStruct {
    dw_data: usize,
    cb_data: u32,
    lp_data: *mut core::ffi::c_void,
}

#[repr(C)]
struct CreateStructW {
    lp_create_params: *mut core::ffi::c_void,
}

fn to_wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn try_open_pipe() -> Option<HANDLE> {
    for name in PIPE_NAMES {
        let wide = to_wide(name);
        unsafe {
            let _ = WaitNamedPipeW(wide.as_ptr(), 200);
            let handle = CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            );
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                let mut mode = PIPE_READMODE_MESSAGE;
                let _ =
                    SetNamedPipeHandleState(handle, &mut mode, ptr::null_mut(), ptr::null_mut());
                return Some(handle);
            }
        }
    }
    None
}

fn query_via_pipe(
    handle: HANDLE,
    query: &str,
    max_results: u32,
) -> Result<Vec<EverythingHit>, EverythingError> {
    let payload = build_query2(query, max_results, 0);
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    framed.extend_from_slice(&payload);
    unsafe {
        let mut written = 0u32;
        let ok = WriteFile(
            handle,
            framed.as_ptr(),
            framed.len() as u32,
            &mut written,
            ptr::null_mut(),
        );
        if ok == 0 {
            let _ = CloseHandle(handle);
            return Err(EverythingError::Query(format!(
                "管道写入失败 {}",
                GetLastError()
            )));
        }
        let mut buf = vec![0u8; 1024 * 256];
        let mut read = 0u32;
        let ok = ReadFile(
            handle,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut read,
            ptr::null_mut(),
        );
        let _ = CloseHandle(handle);
        if ok == 0 || read == 0 {
            return Err(EverythingError::Query("管道读取失败".into()));
        }
        buf.truncate(read as usize);
        let body = strip_pipe_length_prefix(&buf);
        let hits = parse_list2(body).or_else(|_| parse_listw(body))?;
        if hits_look_valid(&hits) {
            Ok(hits)
        } else {
            Err(EverythingError::Query("管道返回了无法识别的路径".into()))
        }
    }
}

struct ReplySlot {
    bytes: Vec<u8>,
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        if msg == WM_NCCREATE {
            let cs = lparam as *const CreateStructW;
            if !cs.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*cs).lp_create_params as isize);
            }
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        if msg == WM_COPYDATA {
            let slot = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ReplySlot;
            let cds = lparam as *const CopyDataStruct;
            if !slot.is_null() && !cds.is_null() && !(*cds).lp_data.is_null() && (*cds).cb_data > 0
            {
                let src = std::slice::from_raw_parts(
                    (*cds).lp_data as *const u8,
                    (*cds).cb_data as usize,
                );
                (*slot).bytes.extend_from_slice(src);
            }
            return 1;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

fn everything_window() -> Option<HWND> {
    let class = to_wide(EVERYTHING_WNDCLASS);
    let hwnd = unsafe { FindWindowW(class.as_ptr(), ptr::null()) };
    if hwnd.is_null() { None } else { Some(hwnd) }
}

fn query_via_copydata(
    query: &str,
    max_results: u32,
) -> Result<Vec<EverythingHit>, EverythingError> {
    let everything = everything_window().ok_or(EverythingError::NotRunning)?;
    let class_name = to_wide("OmniPanelEverythingReply");
    let mut cls = unsafe { mem::zeroed::<WNDCLASSEXW>() };
    cls.cbSize = mem::size_of::<WNDCLASSEXW>() as u32;
    cls.lpfnWndProc = Some(wnd_proc);
    cls.hInstance = unsafe { GetModuleHandleW(ptr::null()) };
    cls.lpszClassName = class_name.as_ptr();
    unsafe {
        let atom = RegisterClassExW(&cls);
        if atom == 0 && GetLastError() != 1410 {
            // 1410 = already registered
            return Err(EverythingError::Query("无法注册回复窗口".into()));
        }
        let mut slot = ReplySlot { bytes: Vec::new() };
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            ptr::null_mut(),
            cls.hInstance,
            &mut slot as *mut ReplySlot as *mut _,
        );
        if hwnd.is_null() {
            let _ = UnregisterClassW(class_name.as_ptr(), cls.hInstance);
            return Err(EverythingError::Query("无法创建回复窗口".into()));
        }
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut slot as *mut ReplySlot as isize);
        let reply_hwnd = hwnd as u32;
        let attempts: [(u32, Vec<u8>); 2] = [
            (QUERY2W, build_query2(query, max_results, reply_hwnd)),
            (QUERYW, build_queryw(query, max_results, reply_hwnd)),
        ];
        let mut last_err = EverythingError::Query("Everything 未接受查询".into());
        for (dw_data, payload) in attempts {
            slot.bytes.clear();
            let mut cds = CopyDataStruct {
                dw_data: dw_data as usize,
                cb_data: payload.len() as u32,
                lp_data: payload.as_ptr() as *mut _,
            };
            let sent = SendMessageW(
                everything,
                WM_COPYDATA,
                hwnd as WPARAM,
                &mut cds as *mut CopyDataStruct as LPARAM,
            );
            if sent == 0 && slot.bytes.is_empty() {
                last_err = EverythingError::Query("Everything 未接受查询".into());
                continue;
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            while slot.bytes.is_empty() && Instant::now() < deadline {
                let mut msg = mem::zeroed();
                while PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            if slot.bytes.is_empty() {
                last_err = EverythingError::Query("等待 Everything 结果超时".into());
                continue;
            }
            let parsed = if dw_data == QUERY2W {
                parse_list2(&slot.bytes).or_else(|_| parse_listw(&slot.bytes))
            } else {
                parse_listw(&slot.bytes).or_else(|_| parse_list2(&slot.bytes))
            };
            match parsed {
                Ok(hits) if hits_look_valid(&hits) => {
                    DestroyWindow(hwnd);
                    let _ = UnregisterClassW(class_name.as_ptr(), cls.hInstance);
                    return Ok(hits);
                }
                Ok(_) => {
                    last_err = EverythingError::Query("COPYDATA 返回了无法识别的路径".into());
                }
                Err(err) => last_err = err,
            }
        }
        DestroyWindow(hwnd);
        let _ = UnregisterClassW(class_name.as_ptr(), cls.hInstance);
        Err(last_err)
    }
}

pub fn search(query: &str, max_results: u32) -> Result<Vec<EverythingHit>, EverythingError> {
    if let Some(handle) = try_open_pipe() {
        match query_via_pipe(handle, query, max_results) {
            Ok(hits) => return Ok(hits),
            Err(_) => {
                // 管道存在但协议不匹配时回退 COPYDATA
            }
        }
    }
    if everything_window().is_none() && try_open_pipe().is_none() {
        return Err(EverythingError::NotRunning);
    }
    query_via_copydata(query, max_results)
}
