/// SSH 仅对 critical 级破坏命令强制在场；普通 prod `ls` 不弹。
pub fn ssh_command_is_critical(command: &str) -> bool {
    let compact = command
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compact.contains("rm ")
        && (compact.contains("-rf")
            || compact.contains("-fr")
            || compact.contains("--recursive")
            || compact.contains("--force"))
    {
        return true;
    }
    if compact.contains(">/dev/sd") || compact.contains("mkfs.") {
        return true;
    }
    if compact.contains("dd ") && compact.contains("of=/dev") {
        return true;
    }
    if compact.contains(":(){") {
        return true;
    }
    if compact.contains("format-volume") {
        return true;
    }
    if compact.contains("remove-item") && compact.contains("-recurse") && compact.contains("-force")
    {
        return true;
    }
    false
}

/// 面板 HTTP 代理：删除站点 / 库 / 计划 / 证书 / 应用。
pub fn panel_request_is_destructive(path: &str, body: Option<&str>) -> bool {
    let hay = format!(
        "{} {}",
        path.to_ascii_lowercase(),
        body.unwrap_or("").to_ascii_lowercase()
    );
    const KEYS: &[&str] = &[
        "/del",
        "delete",
        "uninstall",
        "destroysite",
        "deletesite",
        "deletedatabase",
        "deletecron",
        "deletessl",
        "removeapp",
        "uninstallapp",
        "action=del",
        "action=delete",
    ];
    KEYS.iter().any(|k| hay.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_rm_rf_not_ls() {
        assert!(ssh_command_is_critical("sudo rm -rf /var/lib"));
        assert!(!ssh_command_is_critical("ls -la /var/lib"));
        assert!(ssh_command_is_critical("dd if=/dev/zero of=/dev/sda"));
    }

    #[test]
    fn panel_delete_paths() {
        assert!(panel_request_is_destructive("/websites/del", None));
        assert!(panel_request_is_destructive(
            "/database?action=DeleteDatabase",
            None
        ));
        assert!(!panel_request_is_destructive("/websites/list", None));
    }
}
