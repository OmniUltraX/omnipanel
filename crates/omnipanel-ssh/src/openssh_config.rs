//! 解析 OpenSSH 客户端配置（`~/.ssh/config`）。

use std::path::{Path, PathBuf};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

/// `~/.ssh/config` 中的一个 Host 条目（已展开 HostName）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// 默认 OpenSSH 配置文件路径（`~/.ssh/config`）。
pub fn default_ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh").join("config"))
}

fn home_dir_from_env(var: &str) -> Option<PathBuf> {
    std::env::var(var)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn home_dir() -> Option<PathBuf> {
    home_dir_from_env("USERPROFILE").or_else(|| home_dir_from_env("HOME"))
}

fn expand_path(path: &str, base_dir: &Path) -> PathBuf {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        home_dir()
            .map(|h| h.join(rest))
            .unwrap_or_else(|| base_dir.join(rest))
    } else if trimmed == "~" {
        home_dir().unwrap_or_else(|| base_dir.to_path_buf())
    } else if trimmed.starts_with('/') || (cfg!(windows) && trimmed.contains(':')) {
        PathBuf::from(trimmed)
    } else {
        base_dir.join(trimmed)
    }
}

fn is_connectable_alias(alias: &str) -> bool {
    if alias == "*" {
        return false;
    }
    !alias.contains(['*', '?', '!', '%'])
}

/// 读取并解析配置文件（含 `Include`）。
pub fn load_ssh_config_hosts() -> OmniResult<Vec<SshConfigEntry>> {
    let path = default_ssh_config_path()
        .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "无法定位用户主目录"))?;
    load_ssh_config_hosts_from(&path)
}

pub fn load_ssh_config_hosts_from(path: &Path) -> OmniResult<Vec<SshConfigEntry>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 SSH 配置文件失败").with_cause(e.to_string())
    })?;
    let base_dir = path.parent().unwrap_or(Path::new("."));
    let mut entries = parse_ssh_config_text(&content, base_dir)?;
    entries.sort_by_key(|entry| entry.alias.to_lowercase());
    entries.dedup_by(|a, b| a.alias == b.alias);
    Ok(entries)
}

/// 按 Host 别名查找条目（用于连接）。
pub fn find_ssh_config_entry(alias: &str) -> OmniResult<Option<SshConfigEntry>> {
    let hosts = load_ssh_config_hosts()?;
    Ok(hosts.into_iter().find(|h| h.alias == alias))
}

fn parse_ssh_config_text(content: &str, base_dir: &Path) -> OmniResult<Vec<SshConfigEntry>> {
    let mut out = Vec::new();
    let mut current_hosts: Vec<String> = Vec::new();
    let mut block = HostBlock::default();
    let mut includes: Vec<PathBuf> = Vec::new();

    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let values: Vec<String> = parts.map(|s| s.to_string()).collect();
        if key.is_empty() {
            continue;
        }

        match key.as_str() {
            "host" => {
                flush_block(&mut current_hosts, &mut block, &mut out);
                current_hosts = values;
            }
            "hostname" if !values.is_empty() => block.host_name = Some(values[0].clone()),
            "user" if !values.is_empty() => block.user = Some(values[0].clone()),
            "port" if !values.is_empty() => {
                block.port = values[0].parse().ok();
            }
            "identityfile" if !values.is_empty() => {
                block.identity_file = Some(
                    expand_path(&values[0], base_dir)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            "include" => {
                for value in values {
                    includes.push(expand_path(&value, base_dir));
                }
            }
            _ => {}
        }
    }
    flush_block(&mut current_hosts, &mut block, &mut out);

    for include_path in includes {
        if include_path.is_file() {
            let nested = std::fs::read_to_string(&include_path).map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取 SSH Include 文件失败").with_cause(e.to_string())
            })?;
            let parent = include_path.parent().unwrap_or(base_dir);
            out.extend(parse_ssh_config_text(&nested, parent)?);
        } else if include_path.is_dir() {
            let Ok(read_dir) = std::fs::read_dir(&include_path) else {
                continue;
            };
            let mut files: Vec<PathBuf> = read_dir
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();
            for file in files {
                if let Ok(nested) = std::fs::read_to_string(&file) {
                    let parent = file.parent().unwrap_or(base_dir);
                    out.extend(parse_ssh_config_text(&nested, parent)?);
                }
            }
        }
    }

    Ok(out)
}

#[derive(Default)]
struct HostBlock {
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
}

fn flush_block(hosts: &mut Vec<String>, block: &mut HostBlock, out: &mut Vec<SshConfigEntry>) {
    if hosts.is_empty() {
        block.clear();
        return;
    }
    for alias in hosts.drain(..) {
        if !is_connectable_alias(&alias) {
            continue;
        }
        let host_name = block
            .host_name
            .clone()
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| alias.clone());
        out.push(SshConfigEntry {
            alias: alias.clone(),
            host_name,
            user: block.user.clone(),
            port: block.port,
            identity_file: block.identity_file.clone(),
        });
    }
    block.clear();
}

impl HostBlock {
    fn clear(&mut self) {
        self.host_name = None;
        self.user = None;
        self.port = None;
        self.identity_file = None;
    }
}

/// 将配置条目转为连接用 [`crate::SshConfig`]（读取 IdentityFile）。
pub fn ssh_config_to_connect_config(entry: &SshConfigEntry) -> OmniResult<crate::SshConfig> {
    use crate::{SshAuth, SshConfig};

    let auth = if let Some(path) = &entry.identity_file {
        let pem = std::fs::read_to_string(path).map_err(|e| {
            OmniError::new(ErrorCode::Auth, "读取 SSH 私钥失败")
                .with_cause(format!("{path}: {}", e))
        })?;
        SshAuth::PrivateKey {
            pem,
            passphrase: None,
        }
    } else {
        return Err(OmniError::new(
            ErrorCode::Auth,
            format!(
                "Host `{}` 未配置 IdentityFile，请在 ~/.ssh/config 中指定私钥",
                entry.alias
            ),
        ));
    };

    Ok(SshConfig {
        host: entry.host_name.clone(),
        port: entry.port.unwrap_or(22),
        user: entry
            .user
            .clone()
            .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "root".into())),
        auth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_hosts() {
        let text = r#"
Host jump prod-web
    HostName 10.0.0.1
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host *
    ForwardAgent yes
"#;
        let entries = parse_ssh_config_text(text, Path::new("/home/user/.ssh")).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].alias, "jump");
        assert_eq!(entries[0].host_name, "10.0.0.1");
        assert_eq!(entries[0].user.as_deref(), Some("deploy"));
        assert_eq!(entries[0].port, Some(2222));
        assert_eq!(entries[1].alias, "prod-web");
    }

    #[test]
    fn skip_wildcard_only() {
        let text = "Host *\n  HostName nowhere\n";
        let entries = parse_ssh_config_text(text, Path::new(".")).unwrap();
        assert!(entries.is_empty());
    }
}
