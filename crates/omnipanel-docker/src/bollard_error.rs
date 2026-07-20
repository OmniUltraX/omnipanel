//! bollard / hyper 错误归类。

use omnipanel_error::{ErrorCode, OmniError};

/// 是否为「连不上 Docker Engine」类错误（管道/socket 不存在、拒绝连接等）。
pub fn is_docker_connect_error_message(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("error trying to connect")
        || m.contains("client error (connect)")
        || m.contains("hyper legacy client")
        || m.contains("no such file or directory")
        || m.contains("the system cannot find the file")
        || m.contains("cannot find the file specified")
        || m.contains("connection refused")
        || m.contains("broken pipe")
        || m.contains("管道")
        || m.contains("os error 2")
        || m.contains("os error 111")
        || m.contains("os error 61")
}

/// bollard 错误 → OmniError；连通性问题用 Connection，其余用 Internal。
pub fn map_bollard_error(err: bollard::errors::Error, operation_label: &str) -> OmniError {
    let msg = err.to_string();
    if is_docker_connect_error_message(&msg) {
        OmniError::new(ErrorCode::Connection, "Docker 未安装或未启动").with_cause(msg)
    } else {
        OmniError::new(ErrorCode::Internal, operation_label).with_cause(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_hyper_connect_errors() {
        assert!(is_docker_connect_error_message(
            "Error in the hyper legacy client: client error (Connect)"
        ));
        assert!(is_docker_connect_error_message(
            "error trying to connect: No such file or directory"
        ));
        assert!(!is_docker_connect_error_message("container not found"));
    }
}
