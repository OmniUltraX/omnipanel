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
    default_ssh_dir().map(|dir| dir.join("config"))
}

/// 默认 OpenSSH 私钥目录（`~/.ssh`）。
pub fn default_ssh_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh"))
}

/// OpenSSH 客户端默认 IdentityFile 顺序（与 `ssh_config` 一致）。
const DEFAULT_IDENTITY_FILE_NAMES: &[&str] =
    &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_xmss"];

fn ssh_dir_skip_file_name(name: &str) -> bool {
    matches!(
        name,
        "config"
            | "known_hosts"
            | "known_hosts.old"
            | "authorized_keys"
            | "authorized_keys2"
            | "environment"
            | "rc"
            | "motd"
    ) || name.ends_with(".pub")
}

/// 从 OpenSSH 公钥文本解析 SHA256 指纹与注释。
pub fn ssh_public_key_meta(pub_content: &str) -> (String, String) {
    use russh::keys::ssh_key::{HashAlg, PublicKey};

    let trimmed = pub_content.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    let comment = trimmed
        .splitn(3, ' ')
        .nth(2)
        .unwrap_or("")
        .trim()
        .to_string();
    if let Ok(key) = PublicKey::from_openssh(trimmed) {
        let fp = key.fingerprint(HashAlg::Sha256);
        return (fp.to_string(), comment);
    }
    (String::new(), comment)
}

fn looks_like_private_key_pem(content: &str) -> bool {
    let trimmed = content.trim_start();
    trimmed.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN RSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN EC PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN DSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN PRIVATE KEY-----")
}

/// 判断文本是否为 OpenSSH / PEM 私钥内容。
pub fn is_private_key_pem_content(content: &str) -> bool {
    looks_like_private_key_pem(content)
}

fn is_private_key_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    looks_like_private_key_pem(&content)
}

/// 在指定 `.ssh` 目录中查找可用私钥（先默认文件名，再扫描其余文件）。
pub fn discover_ssh_identity_file_in(ssh_dir: &Path) -> Option<PathBuf> {
    if !ssh_dir.is_dir() {
        return None;
    }

    for name in DEFAULT_IDENTITY_FILE_NAMES {
        let path = ssh_dir.join(name);
        if is_private_key_file(&path) {
            return Some(path);
        }
    }

    let Ok(read_dir) = std::fs::read_dir(ssh_dir) else {
        return None;
    };
    let mut candidates: Vec<PathBuf> = read_dir
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            !ssh_dir_skip_file_name(name)
        })
        .filter(|p| is_private_key_file(p))
        .collect();
    candidates.sort();
    candidates.first().cloned()
}

/// 在用户主目录 `~/.ssh` 中查找可用私钥。
pub fn discover_ssh_identity_file() -> Option<PathBuf> {
    default_ssh_dir().and_then(|dir| discover_ssh_identity_file_in(&dir))
}

/// 列出指定 `.ssh` 目录中的全部私钥路径（默认文件名优先，其余按名称排序）。
pub fn list_ssh_private_key_paths_in(ssh_dir: &Path) -> Vec<PathBuf> {
    if !ssh_dir.is_dir() {
        return Vec::new();
    }

    let mut keys = Vec::new();
    for name in DEFAULT_IDENTITY_FILE_NAMES {
        let path = ssh_dir.join(name);
        if is_private_key_file(&path) {
            keys.push(path);
        }
    }

    let Ok(read_dir) = std::fs::read_dir(ssh_dir) else {
        return keys;
    };
    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if ssh_dir_skip_file_name(name) {
            continue;
        }
        if is_private_key_file(&path) && !keys.iter().any(|p| p == &path) {
            keys.push(path);
        }
    }
    keys.sort();
    keys
}

/// 列出用户主目录 `~/.ssh` 中的全部私钥路径。
pub fn list_ssh_private_key_paths() -> Vec<PathBuf> {
    default_ssh_dir()
        .map(|dir| list_ssh_private_key_paths_in(&dir))
        .unwrap_or_default()
}

fn resolve_identity_file_path(entry: &SshConfigEntry) -> OmniResult<PathBuf> {
    if let Some(path) = &entry.identity_file {
        let pb = PathBuf::from(path);
        if !pb.is_file() {
            return Err(OmniError::new(
                ErrorCode::Auth,
                format!("IdentityFile 不存在: {path}"),
            ));
        }
        return Ok(pb);
    }

    discover_ssh_identity_file().ok_or_else(|| {
        OmniError::new(
            ErrorCode::Auth,
            format!(
                "Host `{}` 未配置 IdentityFile，且在 ~/.ssh 中未找到可用私钥",
                entry.alias
            ),
        )
    })
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

/// 将配置条目转为连接用 [`crate::SshConfig`]（IdentityFile 缺失时使用 Auto 私钥选择）。
pub fn ssh_config_to_connect_config(entry: &SshConfigEntry) -> OmniResult<crate::SshConfig> {
    use crate::{SshAuth, SshConfig};

    let key_path = if entry.identity_file.is_some() {
        Some(
            resolve_identity_file_path(entry)?
                .to_string_lossy()
                .to_string(),
        )
    } else {
        Some("auto".to_string())
    };
    let auth = SshAuth::PrivateKey {
        pem: None,
        key_path,
        passphrase: None,
    };

    Ok(SshConfig {
        host: entry.host_name.clone(),
        port: entry.port.unwrap_or(22),
        user: entry
            .user
            .clone()
            .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "root".into())),
        auth,
        public_ip: None,
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

    #[test]
    fn discover_prefers_default_identity_names() {
        let base = std::env::temp_dir().join(format!("omnipanel-ssh-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("custom_key"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        std::fs::write(
            base.join("id_ed25519"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\ndef\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();

        let found = discover_ssh_identity_file_in(&base).unwrap();
        assert_eq!(
            found.file_name().and_then(|n| n.to_str()),
            Some("id_ed25519")
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn discover_falls_back_to_custom_key() {
        let base =
            std::env::temp_dir().join(format!("omnipanel-ssh-test-custom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("my_server"),
            "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n",
        )
        .unwrap();

        let found = discover_ssh_identity_file_in(&base).unwrap();
        assert_eq!(
            found.file_name().and_then(|n| n.to_str()),
            Some("my_server")
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn discover_skips_pub_and_config() {
        let base =
            std::env::temp_dir().join(format!("omnipanel-ssh-test-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("config"), "Host x").unwrap();
        std::fs::write(base.join("id_rsa.pub"), "ssh-rsa AAAA").unwrap();

        assert!(discover_ssh_identity_file_in(&base).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }
}
