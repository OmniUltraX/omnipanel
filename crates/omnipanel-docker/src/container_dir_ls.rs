//! 容器内目录列表：统一解析 `ls -lan` 输出（避免 `docker cp`/tar 整树复制导致卡死）。

use crate::model::DockerFileEntry;

/// 规范化容器内路径；空串视为根目录。
pub fn normalize_container_dir_path(path: &str) -> &str {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

/// 解析 `ls -lan` 标准输出为文件条目（忽略 `.` / `..` / total）。
pub fn parse_ls_lan_output(stdout: &str) -> Vec<DockerFileEntry> {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("total ") {
            continue;
        }
        if let Some(entry) = parse_ls_lan_line(line) {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            entries.push(entry);
        }
    }
    entries
}

fn parse_ls_lan_line(line: &str) -> Option<DockerFileEntry> {
    // `ls -lan` 输出如：
    //   -rw-r--r-- 1 0 0 1234 Jun 5 10:11 file.txt
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }
    let mode_str = parts[0];
    let size: i64 = parts.get(4)?.parse().ok()?;
    let is_link = mode_str.starts_with('l');
    let is_dir = mode_str.starts_with('d');
    let mode = parse_mode_string(mode_str);
    let name = parts[8..].join(" ");
    if name.is_empty() {
        return None;
    }
    let path = name.clone();
    Some(DockerFileEntry {
        name,
        path,
        size_bytes: size,
        modified_at: 0,
        mode,
        is_dir,
        is_symlink: is_link,
    })
}

fn parse_mode_string(s: &str) -> u32 {
    if s.len() < 10 {
        return 0;
    }
    let mut mode: u32 = match s.chars().next() {
        Some('d') => 0o040000,
        Some('l') => 0o120000,
        Some('-') => 0o100000,
        Some('c') => 0o020000,
        Some('b') => 0o060000,
        Some('p') => 0o010000,
        Some('s') => 0o140000,
        _ => 0,
    };
    let chars: Vec<char> = s.chars().collect();
    let triplet = |i: usize| -> u32 {
        let a = chars.get(i).copied().unwrap_or('-');
        let b = chars.get(i + 1).copied().unwrap_or('-');
        let c = chars.get(i + 2).copied().unwrap_or('-');
        let parse_bit = |ch: char, bit: u32| {
            if matches!(ch, 'r' | 'w' | 'x' | 's' | 't' | 'S' | 'T') {
                bit
            } else {
                0
            }
        };
        match i {
            1 => parse_bit(a, 0o400) | parse_bit(b, 0o200) | parse_bit(c, 0o100),
            4 => parse_bit(a, 0o040) | parse_bit(b, 0o020) | parse_bit(c, 0o010),
            7 => parse_bit(a, 0o004) | parse_bit(b, 0o002) | parse_bit(c, 0o001),
            _ => 0,
        }
    };
    mode |= triplet(1);
    mode |= triplet(4);
    mode |= triplet(7);
    mode
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_empty_to_root() {
        assert_eq!(normalize_container_dir_path(""), "/");
        assert_eq!(normalize_container_dir_path("  "), "/");
        assert_eq!(normalize_container_dir_path("/app"), "/app");
    }

    #[test]
    fn parse_skips_dot_entries() {
        let out = "total 8\ndrwxr-xr-x 1 0 0 4096 Jan 1 00:00 .\ndrwxr-xr-x 1 0 0 4096 Jan 1 00:00 ..\n-rw-r--r-- 1 0 0 12 Jan 1 00:00 a.txt\n";
        let entries = parse_ls_lan_output(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a.txt");
        assert!(!entries[0].is_dir);
    }
}
