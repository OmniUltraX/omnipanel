//! 远端压缩包列目录与工具安装（自桌面端 ssh.rs 移植）。
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError};
use serde::Serialize;

use crate::monitoring::ensure_ssh_session;
use crate::terminal::ServerState;

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// ============================================================================
// 压缩包条目预览：远端执行 unzip -l / tar -tvf / 7z l / unrar l 列条目
// 不下载文件到本地，远端工具缺失时返回 tool_missing 供前端一键安装
// ============================================================================

/// 单个压缩包条目
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// 条目相对路径（含目录层级）
    pub name: String,
    /// 解压后字节数（无法解析时为 0）
        pub size: u64,
    /// 修改时间 Unix 秒（无法解析时为 null）
        pub modified: Option<i64>,
    /// 是否为目录
    pub is_dir: bool,
}

/// 列压缩包条目结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListResult {
    pub entries: Vec<ArchiveEntry>,
    /// 检测到的格式：zip / tar / tar.gz / tar.bz2 / tar.xz / tar.zst / 7z / rar
    pub format: String,
    /// 解压后总字节数
        pub total_uncompressed: u64,
    /// 远端工具缺失时返回提示（如 "unzip"），前端可调 ssh_pool_install_archive_tool
    pub tool_missing: Option<String>,
}

/// 单个安装工具结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveToolInstallResult {
    /// 工具二进制名：unzip / 7z / unrar / zstd / tar
    pub tool: String,
    pub installed: bool,
    /// 安装输出（成功或失败原因）
    pub message: String,
}

/// 按文件名扩展名识别压缩包格式，返回 (format, dispatch_tool)。
/// dispatch_tool 为远端要用的二进制名（unzip / tar / 7z / unrar / zstd）。
fn detect_archive_format(name: &str) -> Option<(&'static str, &'static str)> {
    let lower = name.to_ascii_lowercase();
    // 优先匹配复合扩展名
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Some(("tar.gz", "tar"));
    }
    if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") || lower.ends_with(".tbz") {
        return Some(("tar.bz2", "tar"));
    }
    if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        return Some(("tar.xz", "tar"));
    }
    if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        return Some(("tar.zst", "tar"));
    }
    if lower.ends_with(".tar") {
        return Some(("tar", "tar"));
    }
    if lower.ends_with(".zip") {
        return Some(("zip", "unzip"));
    }
    if lower.ends_with(".7z") {
        return Some(("7z", "7z"));
    }
    if lower.ends_with(".rar") {
        return Some(("rar", "unrar"));
    }
    // 单层压缩格式（非 tar 容器）：gzip/bzip2/xz/zst 本身只能压单文件，
    // 列条目意义不大，这里也归 zip 类工具不支持
    None
}

/// 解析 `unzip -l` 输出（Info-ZIP 格式，跨 unzip 实现稳定）
/// 格式示例：
/// ```text
///   Length      Date    Time    Name
/// ---------  ---------- -----   ----
///         0  2024-01-01 00:00   dir/
///       123  2024-01-01 00:00   file.txt
/// ---------                     -------
/// ```
fn parse_unzip_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        // 表头检测：包含 "Length" / "Date" / "Time" / "Name"
        if !in_table {
            if trimmed.contains("Length") && trimmed.contains("Date") && trimmed.contains("Name") {
                in_table = true;
            }
            continue;
        }
        // 表尾：以 "---------" 开头且后面只有空格/减号
        if trimmed.starts_with("---------") {
            break;
        }
        // 跳过空行
        if trimmed.is_empty() {
            continue;
        }
        // 解析列：长度(10) 日期(10) 时间(5) 名称(剩余)
        // 实际格式前 27 字符为定宽列，28 起为文件名
        if line.len() < 28 {
            continue;
        }
        let size_str = line[..10].trim();
        let date_str = line[11..21].trim();
        let time_str = line.get(22..27).unwrap_or("").trim();
        let name = line[28..].trim();
        if name.is_empty() {
            continue;
        }
        let size: u64 = size_str.parse().unwrap_or(0);
        let is_dir = name.ends_with('/');
        let modified = parse_date_time(date_str, time_str);
        entries.push(ArchiveEntry {
            name: name.to_string(),
            size,
            modified,
            is_dir,
        });
    }
    entries
}

/// 解析 `tar -tvf` 输出（GNU tar 长格式）
/// 格式：`-rw-r--r-- 0/user group 123 2024-01-01 00:00 file.txt`
fn parse_tar_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 6 {
            continue;
        }
        // 第一列权限：10 字符（如 -rw-r--r-- / drwxr-xr-x）
        let perms = tokens[0];
        if perms.len() < 10 {
            continue;
        }
        let is_dir = perms.starts_with('d');
        // size 是 tokens[1..] 中第一个能解析为数字的字段（跳过 perms/owner/group）
        let mut size: u64 = 0;
        let mut size_idx = 0;
        for (i, tok) in tokens.iter().enumerate().skip(1) {
            if let Ok(n) = tok.parse::<u64>() {
                size = n;
                size_idx = i;
                break;
            }
        }
        if size_idx == 0 {
            continue;
        }
        // size 后是 date time [tz] name
        let date_idx = size_idx + 1;
        let time_idx = size_idx + 2;
        if tokens.len() <= time_idx {
            continue;
        }
        let date_str = tokens[date_idx];
        let time_str = tokens[time_idx];
        let modified = parse_date_time(date_str, time_str);
        // 跳过可能的时区字段（如 "UTC" 或 "+0000"）
        let mut name_idx = size_idx + 3;
        while name_idx < tokens.len() {
            let t = tokens[name_idx];
            // 时区字段：纯数字偏移（+0000）或纯字母（UTC/GMT）
            if (t.starts_with('+') || t.starts_with('-'))
                && t.len() == 5
                && t[1..].chars().all(|c| c.is_ascii_digit())
            {
                name_idx += 1;
                continue;
            }
            if t == "UTC" || t == "GMT" {
                name_idx += 1;
                continue;
            }
            break;
        }
        if name_idx >= tokens.len() {
            continue;
        }
        // name 是剩余 token 用空格连接（文件名可能含空格）
        let name = tokens[name_idx..].join(" ");
        // 去除 GNU tar 可能的引号包裹
        let name = name.trim_matches('"');
        if name.is_empty() {
            continue;
        }
        let is_dir_final = is_dir || name.ends_with('/');
        entries.push(ArchiveEntry {
            name: name.to_string(),
            size,
            modified,
            is_dir: is_dir_final,
        });
    }
    entries
}

/// 解析 `7z l` 输出（p7zip / 7-Zip 列表模式）
/// 格式：
/// ```text
///    Date      Time    Attr         Size   Compressed  Name
/// ------------------- ----- ------------ ------------  ----------------
/// 2024-01-01 00:00:00 ....A          123          100  file.txt
/// ------------------- ----- ------------ ------------  ----------------
/// ```
fn parse_7z_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        if !in_table {
            // 表头：包含 Date Time Attr Size Name
            if trimmed.contains("Date")
                && trimmed.contains("Attr")
                && trimmed.contains("Name")
            {
                in_table = true;
            }
            continue;
        }
        // 表尾分隔行
        if trimmed.starts_with("---") {
            if entries.is_empty() {
                // 可能是表头后的第一行分隔，跳过
                continue;
            } else {
                break;
            }
        }
        if trimmed.is_empty() {
            continue;
        }
        // 格式：YYYY-MM-DD HH:MM:SS attr(5) size(12) compressed(12) name
        // 用 split_whitespace 拆分，name 是剩余部分
        if line.len() < 54 {
            continue;
        }
        let date_str = &line[0..10];
        let time_str = &line[11..19];
        let attr = line[20..25].trim();
        let size_str = line[26..38].trim();
        // name 从第 54 字符起
        let name = line.get(54..).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let size: u64 = size_str.replace(',', "").parse().unwrap_or(0);
        let modified = parse_date_time(date_str, time_str);
        let is_dir = attr.contains('D') || name.ends_with('/');
        entries.push(ArchiveEntry {
            name: name.to_string(),
            size,
            modified,
            is_dir,
        });
    }
    entries
}

/// 解析 `unrar l` 输出
/// 格式：
/// ```text
/// Attributes      Size  Packed Ratio    Date    Time   CRC32  Method  Version  Name
/// -------------------------------------------------------------------------------
/// -rw-r--r--     123     100  81%  2024-01-01 00:00  ABCDEF00  m3a    3    file.txt
/// -------------------------------------------------------------------------------
/// ```
fn parse_unrar_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        if !in_table {
            // 表头：包含 Attributes Size Date Name
            if trimmed.contains("Attributes")
                && trimmed.contains("Size")
                && trimmed.contains("Name")
            {
                in_table = true;
            }
            continue;
        }
        // 分隔线
        if trimmed.starts_with("---") {
            if entries.is_empty() {
                continue;
            } else {
                break;
            }
        }
        if trimmed.is_empty() {
            continue;
        }
        // 用 split_whitespace 拆分 token
        // 格式：attrs size packed ratio date time crc method version name...
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 10 {
            continue;
        }
        let attrs = tokens[0];
        let size_str = tokens[1];
        let date_str = tokens[4];
        let time_str = tokens[5];
        // name 是 version 后的剩余部分（token 9 起）
        let name = tokens[9..].join(" ");
        let size: u64 = size_str.parse().unwrap_or(0);
        let modified = parse_date_time(date_str, time_str);
        let is_dir = attrs.starts_with('d') || name.ends_with('/');
        entries.push(ArchiveEntry {
            name: name.trim_matches('"').to_string(),
            size,
            modified,
            is_dir,
        });
    }
    entries
}

/// 解析日期时间字符串为 Unix 秒（失败返回 None）
/// 支持格式：YYYY-MM-DD HH:MM[:SS]
fn parse_date_time(date: &str, time: &str) -> Option<i64> {
    if date.len() < 10 {
        return None;
    }
    let y: i32 = date.get(0..4)?.parse().ok()?;
    let m: u32 = date.get(5..7)?.parse().ok()?;
    let d: u32 = date.get(8..10)?.parse().ok()?;
    let time_part = if time.len() >= 5 { time } else { "00:00" };
    let (hh, mm, ss) = if time_part.len() >= 8 {
        let hh: u32 = time_part.get(0..2)?.parse().ok()?;
        let mm: u32 = time_part.get(3..5)?.parse().ok()?;
        let ss: u32 = time_part.get(6..8)?.parse().ok()?;
        (hh, mm, ss)
    } else if time_part.len() >= 5 {
        let hh: u32 = time_part.get(0..2)?.parse().ok()?;
        let mm: u32 = time_part.get(3..5)?.parse().ok()?;
        (hh, mm, 0)
    } else {
        (0, 0, 0)
    };
    days_from_civil(y, m, d).and_then(|days| {
        let secs = (days as i64) * 86400 + (hh as i64) * 3600 + (mm as i64) * 60 + ss as i64;
        Some(secs)
    })
}

/// 公历日期 → 自公元 0001-01-01 起的天数（Howard Hinnant 算法）
fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era as i64) * 146097 + doe as i64 - 719468)
}

/// 列出远端压缩包条目（不在本地下载文件，远端执行 unzip/tar/7z/unrar）。
/// 远端工具缺失时返回 `tool_missing`，前端可调 `ssh_pool_install_archive_tool` 一键安装后重试。
pub async fn ssh_pool_list_archive_entries(
    state: &ServerState,
    resource_id: String,
    path: String,
) -> Result<ArchiveListResult, OmniError> {
    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let (format, tool) = detect_archive_format(name).ok_or_else(|| {
        OmniError::new(
            ErrorCode::InvalidInput,
            format!("无法识别压缩包格式: {name}"),
        )
    })?;

    let (session, _) = ensure_ssh_session(state, &resource_id).await?;
    let quoted = shell_single_quote(&path);

    // 构造远端命令
    let cmd = match (format, tool) {
        ("tar", _) => format!("tar -tvf {quoted}"),
        ("tar.gz", _) => format!("tar -tzvf {quoted}"),
        ("tar.bz2", _) => format!("tar -tjvf {quoted}"),
        ("tar.xz", _) => format!("tar -tJvf {quoted}"),
        ("tar.zst", _) => format!("tar --zstd -tvf {quoted}"),
        ("zip", _) => format!("unzip -l {quoted}"),
        ("7z", _) => format!("7z l {quoted}"),
        ("rar", _) => format!("unrar l {quoted}"),
        _ => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("不支持的压缩格式: {format}"),
            ));
        }
    };

    // 先检查工具是否存在，避免 unzip 交互式卡密码提示
    let check = format!("command -v {tool} >/dev/null 2>&1 && echo OK || echo MISSING");
    let check_output = session.exec_capture(&check).await?;
    if check_output.stdout.trim() == "MISSING" {
        return Ok(ArchiveListResult {
            entries: Vec::new(),
            format: format.to_string(),
            total_uncompressed: 0,
            tool_missing: Some(tool.to_string()),
        });
    }

    // 加密 zip 防卡密码：unzip 传 -P '' 让它直接报错而非挂起
    let safe_cmd = if format == "zip" {
        format!("unzip -P '' -l {quoted}")
    } else {
        cmd
    };

    // 30s 超时（大压缩包列条目可能慢，但远端工具应能快速返回元数据）
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.exec_capture(&safe_cmd),
    )
    .await
    {
        Ok(r) => r?,
        Err(_) => {
            return Err(OmniError::new(
                ErrorCode::Internal,
                "列出压缩包条目超时（>30s）",
            ));
        }
    };

    // 工具执行但报错（如损坏的压缩包、加密 zip、缺解码库）
    if output.exit_code != 0 {
        let stderr = output.stderr.trim();
        let stdout = output.stdout.trim();
        let detail = if !stderr.is_empty() {
            stderr
        } else {
            stdout
        };
        // 检测加密标志
        if detail.contains("password")
            || detail.contains("encrypted")
            || detail.contains("密码")
        {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "压缩包已加密，不支持预览",
            ));
        }
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!("列出压缩包条目失败: {detail}"),
        ));
    }

    let entries = match format {
        "zip" => parse_unzip_list(&output.stdout),
        "tar" | "tar.gz" | "tar.bz2" | "tar.xz" | "tar.zst" => parse_tar_list(&output.stdout),
        "7z" => parse_7z_list(&output.stdout),
        "rar" => parse_unrar_list(&output.stdout),
        _ => Vec::new(),
    };

    let total_uncompressed: u64 = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();

    Ok(ArchiveListResult {
        entries,
        format: format.to_string(),
        total_uncompressed,
        tool_missing: None,
    })
}

/// 远端工具 → 包名映射（按包管理器）
fn archive_tool_package(tool: &str, pm: &str) -> Option<&'static str> {
    match (tool, pm) {
        ("unzip", "apt") => Some("unzip"),
        ("unzip", "dnf") | ("unzip", "yum") => Some("unzip"),
        ("unzip", "apk") => Some("unzip"),
        ("unzip", "pacman") => Some("unzip"),
        ("unzip", "zypper") => Some("unzip"),

        ("tar", "apt") => Some("tar"),
        ("tar", "dnf") | ("tar", "yum") => Some("tar"),
        ("tar", "apk") => Some("tar"),
        ("tar", "pacman") => Some("tar"),
        ("tar", "zypper") => Some("tar"),

        ("7z", "apt") => Some("p7zip-full"),
        ("7z", "dnf") | ("7z", "yum") => Some("p7zip"),
        ("7z", "apk") => Some("p7zip"),
        ("7z", "pacman") => Some("p7zip"),
        ("7z", "zypper") => Some("p7zip"),

        ("unrar", "apt") => Some("unrar"),
        ("unrar", "dnf") | ("unrar", "yum") => Some("unrar"),
        ("unrar", "apk") => Some("unrar"),
        ("unrar", "pacman") => Some("unrar"),
        ("unrar", "zypper") => Some("unrar"),

        ("zstd", "apt") => Some("zstd"),
        ("zstd", "dnf") | ("zstd", "yum") => Some("zstd"),
        ("zstd", "apk") => Some("zstd"),
        ("zstd", "pacman") => Some("zstd"),
        ("zstd", "zypper") => Some("zstd"),

        _ => None,
    }
}

/// 在远端一键安装压缩包工具（unzip / tar / 7z / unrar / zstd）。
/// 自动检测包管理器（apt/dnf/yum/apk/pacman/zypper），优先用 sudo -n 非交互提权，
/// 失败回退无 sudo 直接安装（root 用户或免密场景）。
pub async fn ssh_pool_install_archive_tool(
    state: &ServerState,
    resource_id: String,
    tool: String,
) -> Result<ArchiveToolInstallResult, OmniError> {
    let tool = tool.trim().to_lowercase();
    let valid_tools = ["unzip", "tar", "7z", "unrar", "zstd"];
    if !valid_tools.contains(&tool.as_str()) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("不支持的工具: {tool}（可选: unzip/tar/7z/unrar/zstd）"),
        ));
    }

    let (session, _) = ensure_ssh_session(state, &resource_id).await?;

    // 检测包管理器
    let detect_pm = r#"command -v apt-get >/dev/null 2>&1 && echo apt || \
(command -v dnf >/dev/null 2>&1 && echo dnf || \
(command -v yum >/dev/null 2>&1 && echo yum || \
(command -v apk >/dev/null 2>&1 && echo apk || \
(command -v pacman >/dev/null 2>&1 && echo pacman || \
(command -v zypper >/dev/null 2>&1 && echo zypper || \
echo UNKNOWN)))))"#;
    let pm_output = session.exec_capture(detect_pm).await?;
    let pm = pm_output.stdout.trim().to_string();
    if pm == "UNKNOWN" || pm.is_empty() {
        return Ok(ArchiveToolInstallResult {
            tool: tool.clone(),
            installed: false,
            message: "未检测到支持的包管理器（apt/dnf/yum/apk/pacman/zypper）".to_string(),
        });
    }

    let pkg = archive_tool_package(&tool, &pm).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("包管理器 {pm} 不支持安装 {tool}"),
        )
    })?;

    // 构造安装命令：sudo -n 优先（非交互），失败回退无 sudo
    let install_cmd = match pm.as_str() {
        "apt" => format!(
            "sudo -n apt-get install -y {pkg} 2>/dev/null || apt-get install -y {pkg} 2>&1"
        ),
        "dnf" => format!(
            "sudo -n dnf install -y {pkg} 2>/dev/null || dnf install -y {pkg} 2>&1"
        ),
        "yum" => format!(
            "sudo -n yum install -y {pkg} 2>/dev/null || yum install -y {pkg} 2>&1"
        ),
        "apk" => format!("apk add --no-progress {pkg} 2>&1 || sudo -n apk add --no-progress {pkg} 2>&1"),
        "pacman" => format!(
            "sudo -n pacman -S --noconfirm --needed {pkg} 2>/dev/null || pacman -S --noconfirm --needed {pkg} 2>&1"
        ),
        "zypper" => format!(
            "sudo -n zypper -n install {pkg} 2>/dev/null || zypper -n install {pkg} 2>&1"
        ),
        _ => {
            return Ok(ArchiveToolInstallResult {
                tool: tool.clone(),
                installed: false,
                message: format!("不支持的包管理器: {pm}"),
            });
        }
    };

    // 安装可能耗时较长，给 120s 超时
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        session.exec_capture(&install_cmd),
    )
    .await
    {
        Ok(r) => r?,
        Err(_) => {
            return Ok(ArchiveToolInstallResult {
                tool: tool.clone(),
                installed: false,
                message: "安装超时（>120s）".to_string(),
            });
        }
    };

    // 校验安装结果：command -v 检查二进制是否可用
    let verify_cmd = format!("command -v {tool} >/dev/null 2>&1 && echo OK || echo FAIL");
    let verify_output = session.exec_capture(&verify_cmd).await?;
    let installed = verify_output.stdout.trim() == "OK";

    let combined = if !output.stderr.trim().is_empty() {
        format!("{}\n{}", output.stdout.trim(), output.stderr.trim())
    } else {
        output.stdout.trim().to_string()
    };
    let message = if installed {
        if combined.is_empty() {
            format!("已安装 {pkg}（{pm}）")
        } else {
            format!("已安装 {pkg}（{pm}）\n{}", combined.chars().take(500).collect::<String>())
        }
    } else if combined.is_empty() {
        format!("安装失败（{pm} install {pkg}）")
    } else {
        combined.chars().take(500).collect::<String>()
    };

    Ok(ArchiveToolInstallResult {
        tool,
        installed,
        message,
    })
}
