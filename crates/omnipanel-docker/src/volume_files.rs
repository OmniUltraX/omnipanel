//! Docker 卷挂载点目录浏览（宿主机 `Mountpoint` 路径）。

use std::path::{Component, Path, PathBuf};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;

use crate::model::DockerFileEntry;

/// 将 SftpPanel 风格路径（`/`、`/foo/bar`）转为卷内相对路径组件。
pub fn normalize_volume_inner_path(path: &str) -> OmniResult<PathBuf> {
    let trimmed = path.trim().replace('\\', "/");
    let rel = trimmed.trim_start_matches('/');
    if rel.is_empty() {
        return Ok(PathBuf::new());
    }
    let mut out = PathBuf::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "卷路径不允许包含 ..",
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "卷路径必须为相对路径",
                ));
            }
        }
    }
    Ok(out)
}

/// 解析卷挂载点下的绝对路径，并阻止目录穿越。
pub fn resolve_volume_absolute_path(mountpoint: &str, inner_path: &str) -> OmniResult<PathBuf> {
    let mount = mountpoint.trim();
    if mount.is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "卷挂载点为空，无法浏览目录",
        ));
    }
    let root = PathBuf::from(mount);
    let rel = normalize_volume_inner_path(inner_path)?;
    let full = if rel.as_os_str().is_empty() {
        root.clone()
    } else {
        root.join(rel)
    };
    Ok(full)
}

pub async fn list_local_volume_dir(
    mountpoint: &str,
    inner_path: &str,
) -> OmniResult<Vec<DockerFileEntry>> {
    let dir = resolve_volume_absolute_path(mountpoint, inner_path)?;
    let mut read_dir = tokio::fs::read_dir(&dir).await.map_err(|error| {
        OmniError::new(ErrorCode::Internal, "列出卷目录失败")
            .with_cause(format!("{}: {error}", dir.display()))
    })?;
    let mut entries = Vec::new();
    while let Some(entry) = read_dir.next_entry().await.map_err(|error| {
        OmniError::new(ErrorCode::Internal, "读取卷目录项失败").with_cause(error.to_string())
    })? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        let meta = entry.metadata().await.map_err(|error| {
            OmniError::new(ErrorCode::Internal, "读取卷目录项元数据失败")
                .with_cause(error.to_string())
        })?;
        let file_type = meta.file_type();
        let is_symlink = file_type.is_symlink();
        let is_dir = meta.is_dir();
        let size_bytes = if is_dir { 0 } else { meta.len() as i64 };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        let display_path = join_volume_display_path(inner_path, &name);
        entries.push(DockerFileEntry {
            name,
            path: display_path,
            size_bytes,
            modified_at,
            mode: 0,
            is_dir,
            is_symlink,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

pub async fn read_local_volume_file(
    mountpoint: &str,
    inner_path: &str,
    max_bytes: i64,
) -> OmniResult<Vec<u8>> {
    let file_path = resolve_volume_absolute_path(mountpoint, inner_path)?;
    let meta = tokio::fs::metadata(&file_path).await.map_err(|error| {
        OmniError::new(ErrorCode::NotFound, "卷内文件不存在")
            .with_cause(format!("{}: {error}", file_path.display()))
    })?;
    if meta.is_dir() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "目标路径是目录，无法预览"));
    }
    if max_bytes > 0 && (meta.len() as i64) > max_bytes {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("文件超过 {} 字节限制", max_bytes),
        ));
    }
    tokio::fs::read(&file_path).await.map_err(|error| {
        OmniError::new(ErrorCode::Internal, "读取卷内文件失败")
            .with_cause(format!("{}: {error}", file_path.display()))
    })
}

pub fn join_volume_display_path(inner_path: &str, name: &str) -> String {
    let base = inner_path.trim().replace('\\', "/");
    let base = base.trim_end_matches('/');
    if base.is_empty() || base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

pub async fn list_ssh_volume_dir(
    session: &SshSession,
    mountpoint: &str,
    inner_path: &str,
) -> OmniResult<Vec<DockerFileEntry>> {
    let full = resolve_volume_absolute_path(mountpoint, inner_path)?;
    let cmd = format!("ls -lan {}", shell_quote(&full.to_string_lossy()));
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(OmniError::new(ErrorCode::Internal, "列出卷目录失败")
            .with_cause(out.stderr.trim().to_string()));
    }
    let mut entries = Vec::new();
    for line in out.stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("total ") {
            continue;
        }
        if let Some(mut entry) = parse_ls_lan_line(line) {
            entry.path = join_volume_display_path(inner_path, &entry.name);
            entries.push(entry);
        }
    }
    Ok(entries)
}

pub async fn read_ssh_volume_file(
    session: &SshSession,
    mountpoint: &str,
    inner_path: &str,
    max_bytes: i64,
) -> OmniResult<Vec<u8>> {
    let full = resolve_volume_absolute_path(mountpoint, inner_path)?;
    let full_str = full.to_string_lossy().to_string();
    let data = session
        .sftp_download(&full_str)
        .await
        .map_err(|error| OmniError::new(ErrorCode::Internal, "读取卷内文件失败").with_cause(error.to_string()))?;
    if max_bytes > 0 && (data.len() as i64) > max_bytes {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("文件超过 {} 字节限制", max_bytes),
        ));
    }
    Ok(data)
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn parse_ls_lan_line(line: &str) -> Option<DockerFileEntry> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }
    let mode_str = parts[0];
    let size: i64 = parts.get(4)?.parse().ok()?;
    let is_link = mode_str.starts_with('l');
    let is_dir = mode_str.starts_with('d');
    let name = parts[8..].join(" ");
    Some(DockerFileEntry {
        name: name.clone(),
        path: name,
        size_bytes: size,
        modified_at: 0,
        mode: 0,
        is_dir,
        is_symlink: is_link,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_segments() {
        assert!(normalize_volume_inner_path("/../etc").is_err());
    }

    #[test]
    fn joins_display_path() {
        assert_eq!(join_volume_display_path("/", "data"), "/data");
        assert_eq!(join_volume_display_path("/app", "log"), "/app/log");
    }
}
