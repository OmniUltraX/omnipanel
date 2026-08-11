//! Web 端明确暂缓的命令（返回结构化错误，不走 soft_degrade 假成功）。

/// 返回暂缓命令的用户可见错误信息。
pub fn deferred_error(cmd: &str) -> String {
    match cmd {
        "sniffer_list_interfaces"
        | "sniffer_start_capture"
        | "sniffer_stop_capture"
        | "sniffer_get_packets"
        | "sniffer_get_stats" => {
            "Web 端暂不支持网络抓包（sniffer），请使用桌面端".to_string()
        }
        "check_update" | "install_update" => {
            "Web 端不支持应用内更新，请从发布渠道获取新版本".to_string()
        }
        _ => format!("Web 端暂不支持命令 `{cmd}`"),
    }
}

pub fn is_deferred(cmd: &str) -> bool {
    matches!(
        cmd,
        "sniffer_list_interfaces"
            | "sniffer_start_capture"
            | "sniffer_stop_capture"
            | "sniffer_get_packets"
            | "sniffer_get_stats"
            | "check_update"
            | "install_update"
    )
}
