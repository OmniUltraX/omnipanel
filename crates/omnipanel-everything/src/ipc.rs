//! Everything QUERY2 / LIST2 / LISTW 编解码。不含 Win32 调用，便于单测。

use crate::{EverythingError, EverythingHit};

pub const QUERYW: u32 = 2;
pub const QUERY2W: u32 = 18;
pub const REQUEST_FULL_PATH_AND_FILE_NAME: u32 = 0x4;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Query2 {
    pub reply_hwnd: u32,
    pub reply_copydata_message: u32,
    pub search_flags: u32,
    pub offset: u32,
    pub max_results: u32,
    pub request_flags: u32,
    pub sort_type: u32,
}

pub fn build_query2(query: &str, max_results: u32, reply_hwnd: u32) -> Vec<u8> {
    let header = Query2 {
        reply_hwnd,
        reply_copydata_message: QUERY2W,
        search_flags: 0,
        offset: 0,
        max_results,
        request_flags: REQUEST_FULL_PATH_AND_FILE_NAME,
        sort_type: 1,
    };
    let mut buf = Vec::new();
    buf.extend_from_slice(unsafe {
        std::slice::from_raw_parts(
            (&header as *const Query2).cast::<u8>(),
            std::mem::size_of::<Query2>(),
        )
    });
    for unit in query.encode_utf16() {
        buf.extend_from_slice(&unit.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf
}

pub fn build_queryw(query: &str, max_results: u32, reply_hwnd: u32) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&reply_hwnd.to_le_bytes());
    buf.extend_from_slice(&QUERYW.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // search_flags
    buf.extend_from_slice(&0u32.to_le_bytes()); // offset
    buf.extend_from_slice(&max_results.to_le_bytes());
    for unit in query.encode_utf16() {
        buf.extend_from_slice(&unit.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf
}

pub fn parse_list2(bytes: &[u8]) -> Result<Vec<EverythingHit>, EverythingError> {
    if bytes.len() < 20 {
        return Err(EverythingError::Query("结果过短".into()));
    }
    let numitems = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut hits = Vec::with_capacity(numitems.min(200));
    let item_start = 20usize;
    let item_size = 8usize;
    if bytes.len() < item_start + numitems.saturating_mul(item_size) {
        return Err(EverythingError::Query("结果表不完整".into()));
    }
    for i in 0..numitems {
        let off = item_start + i * item_size;
        let flags = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        let data_offset = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap()) as usize;
        let path = read_wchar_z(bytes, data_offset)?;
        if path.is_empty() {
            continue;
        }
        hits.push(EverythingHit {
            path,
            is_folder: (flags & 0x1) != 0,
        });
    }
    Ok(hits)
}

pub fn parse_listw(bytes: &[u8]) -> Result<Vec<EverythingHit>, EverythingError> {
    if bytes.len() < 28 {
        return Err(EverythingError::Query("LISTW 结果过短".into()));
    }
    let numitems = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let item_start = 28usize;
    let item_size = 12usize;
    if bytes.len() < item_start + numitems.saturating_mul(item_size) {
        return Err(EverythingError::Query("LISTW 结果表不完整".into()));
    }
    let mut hits = Vec::with_capacity(numitems.min(200));
    for i in 0..numitems {
        let off = item_start + i * item_size;
        let flags = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        let filename_offset =
            u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap()) as usize;
        let path_offset = u32::from_le_bytes(bytes[off + 8..off + 12].try_into().unwrap()) as usize;
        let dir = read_wchar_z(bytes, path_offset)?;
        let name = read_wchar_z(bytes, filename_offset)?;
        let path = join_win_path(&dir, &name);
        if path.is_empty() {
            continue;
        }
        hits.push(EverythingHit {
            path,
            is_folder: (flags & 0x1) != 0,
        });
    }
    Ok(hits)
}

fn join_win_path(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    if name.is_empty() {
        return dir.to_string();
    }
    if dir.ends_with('\\') || dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}\\{name}")
    }
}

fn read_wchar_z(bytes: &[u8], offset: usize) -> Result<String, EverythingError> {
    if offset >= bytes.len() {
        return Err(EverythingError::Query("路径偏移越界".into()));
    }
    let mut units = Vec::new();
    let mut i = offset;
    while i + 1 < bytes.len() {
        let unit = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        i += 2;
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    String::from_utf16(&units).map_err(|_| EverythingError::Query("路径不是合法 UTF-16".into()))
}

pub fn looks_like_win_path(path: &str) -> bool {
    let p = path.trim();
    if p.len() < 3 {
        return false;
    }
    p.contains('\\') || p.contains('/') || p.chars().nth(1) == Some(':')
}

/// 空结果合法；非空则至少一条要像 Windows 路径，避免把管道噪声当成命中。
pub fn hits_look_valid(hits: &[EverythingHit]) -> bool {
    hits.is_empty() || hits.iter().any(|h| looks_like_win_path(&h.path))
}

pub fn strip_pipe_length_prefix(bytes: &[u8]) -> &[u8] {
    if bytes.len() < 4 {
        return bytes;
    }
    let size = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    if size > 0 && size <= bytes.len().saturating_sub(4) && size + 4 == bytes.len() {
        return &bytes[4..4 + size];
    }
    bytes
}
