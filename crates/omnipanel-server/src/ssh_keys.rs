//! SSH 密钥管理（~/.ssh），自桌面端移植。

use std::path::{Path, PathBuf};
use std::process::Command;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{
    is_private_key_pem_content, ssh_public_key_meta,
};

use crate::store_bridge::SshKeyInfo;

fn home_dir() -> OmniResult<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "无法获取用户主目录"))
}

fn ssh_keygen_command() -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("ssh-keygen.exe");
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new("ssh-keygen")
    }
}

fn sanitize_ssh_key_name(name: &str) -> OmniResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "密钥名称不能为空"));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "密钥名称非法"));
    }
    Ok(name.to_string())
}

fn allocate_ssh_key_filename(ssh_dir: &Path, algo: &str, name: Option<&str>) -> OmniResult<String> {
    if let Some(n) = name {
        let n = sanitize_ssh_key_name(n)?;
        let path = ssh_dir.join(&n);
        if path.exists() {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("密钥 `{n}` 已存在"),
            ));
        }
        return Ok(n);
    }
    let base = match algo {
        "ed25519" => "id_ed25519",
        "rsa" => "id_rsa",
        "ecdsa" => "id_ecdsa",
        _ => "id_ed25519",
    };
    let candidate = ssh_dir.join(base);
    if !candidate.exists() {
        return Ok(base.to_string());
    }
    for i in 2..100 {
        let name = format!("{base}_{i}");
        if !ssh_dir.join(&name).exists() {
            return Ok(name);
        }
    }
    Err(OmniError::new(ErrorCode::Io, "无法分配密钥文件名"))
}

fn ssh_key_info_from_path(path: &Path) -> Option<SshKeyInfo> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let pem = std::fs::read_to_string(path).ok()?;
    let key_type = if name.contains("ed25519") || pem.contains("ED25519") {
        "ed25519"
    } else if name.contains("rsa") || pem.contains("RSA") {
        "rsa"
    } else if name.contains("ecdsa") || pem.contains("ECDSA") {
        "ecdsa"
    } else {
        "openssh"
    }
    .to_string();
    let pub_path = PathBuf::from(format!("{}.pub", path.to_string_lossy()));
    let (fingerprint, comment) = if pub_path.is_file() {
        std::fs::read_to_string(&pub_path)
            .map(|content| ssh_public_key_meta(&content))
            .unwrap_or_else(|_| (String::new(), String::new()))
    } else {
        (String::new(), String::new())
    };
    Some(SshKeyInfo {
        name,
        key_type,
        path: path.to_string_lossy().to_string(),
        fingerprint,
        comment,
    })
}

pub async fn ssh_generate_key(
    key_type: String,
    bits: Option<u32>,
    comment: String,
    passphrase: String,
    name: Option<String>,
) -> OmniResult<SshKeyInfo> {
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建 .ssh 目录失败").with_cause(e.to_string())
    })?;

    let algo = match key_type.as_str() {
        "ed25519" => "ed25519",
        "rsa" => "rsa",
        "ecdsa" => "ecdsa",
        _ => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("不支持的密钥类型: {key_type}"),
            ));
        }
    };

    let filename = allocate_ssh_key_filename(&ssh_dir, algo, name.as_deref())?;
    let key_path = ssh_dir.join(&filename);

    let mut cmd = ssh_keygen_command();
    cmd.arg("-t").arg(algo);
    if let Some(b) = bits {
        cmd.arg("-b").arg(b.to_string());
    }
    cmd.arg("-f").arg(&key_path);
    cmd.arg("-C").arg(&comment);
    if passphrase.is_empty() {
        cmd.arg("-N").arg("");
    } else {
        cmd.arg("-N").arg(&passphrase);
    }
    cmd.arg("-q");

    let output = cmd.output().map_err(|e| {
        OmniError::new(ErrorCode::Ssh, "运行 ssh-keygen 失败，请确认已安装 OpenSSH")
            .with_cause(e.to_string())
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(OmniError::new(ErrorCode::Ssh, "ssh-keygen 执行失败").with_cause(
            if stderr.is_empty() {
                format!("exit code {:?}", output.status.code())
            } else {
                stderr
            },
        ));
    }

    ssh_key_info_from_path(&key_path).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("密钥已生成但无法读取: {filename}"),
        )
    })
}

pub async fn ssh_import_key(name: String, private_key: String) -> OmniResult<SshKeyInfo> {
    let trimmed_key = private_key.trim();
    if !is_private_key_pem_content(trimmed_key) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "私钥内容无效，请粘贴 OpenSSH / PEM 格式私钥",
        ));
    }

    let name = sanitize_ssh_key_name(&name)?;
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建 .ssh 目录失败").with_cause(e.to_string())
    })?;

    let key_path = ssh_dir.join(&name);
    if key_path.exists() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("密钥 `{name}` 已存在"),
        ));
    }

    std::fs::write(&key_path, format!("{trimmed_key}\n")).map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入密钥文件失败").with_cause(e.to_string())
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    ssh_key_info_from_path(&key_path).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("密钥已写入但无法解析: {name}"),
        )
    })
}

pub async fn ssh_delete_key(name: String) -> OmniResult<()> {
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    let key_path = ssh_dir.join(&name);
    let pub_path = ssh_dir.join(format!("{name}.pub"));

    if key_path.exists() {
        std::fs::remove_file(&key_path)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除私钥失败").with_cause(e.to_string()))?;
    }
    if pub_path.exists() {
        std::fs::remove_file(&pub_path)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除公钥失败").with_cause(e.to_string()))?;
    }
    Ok(())
}

pub async fn ssh_read_key_private(name: String) -> OmniResult<String> {
    let home = home_dir()?;
    let path = home.join(".ssh").join(&name);
    std::fs::read_to_string(&path).map_err(|e| {
        OmniError::new(ErrorCode::Io, format!("读取私钥失败: {name}")).with_cause(e.to_string())
    })
}

pub async fn ssh_read_key_public(name: String) -> OmniResult<String> {
    let home = home_dir()?;
    let path = home.join(".ssh").join(format!("{name}.pub"));
    std::fs::read_to_string(&path).map_err(|e| {
        OmniError::new(ErrorCode::Io, format!("读取公钥失败: {name}")).with_cause(e.to_string())
    })
}
