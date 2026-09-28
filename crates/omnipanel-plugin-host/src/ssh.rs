//! `sshExec` 的连接归属：只认本次调用开始前宿主写入的 connectionId。

use std::cell::RefCell;
use std::time::Duration;

thread_local! {
    static INJECTED_CONNECTION: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// 在 L2 `call` 期间持有。Drop 时清掉注入，避免串到下一次调用。
pub struct InjectedConnectionGuard;

impl Drop for InjectedConnectionGuard {
    fn drop(&mut self) {
        INJECTED_CONNECTION.with(|slot| *slot.borrow_mut() = None);
    }
}

/// 快照宿主注入的 connectionId。空字符串视为未注入。
pub fn enter_injected_connection(id: Option<String>) -> InjectedConnectionGuard {
    let id = id.filter(|value| !value.trim().is_empty());
    INJECTED_CONNECTION.with(|slot| *slot.borrow_mut() = id);
    InjectedConnectionGuard
}

pub fn injected_connection() -> Option<String> {
    INJECTED_CONNECTION.with(|slot| slot.borrow().clone())
}

/// 壳实现的 SSH 执行。桥负责权限、长度和 prod 确认。
pub trait SshExec: Send + Sync {
    fn exec(&self, connection_id: &str, command: &str, timeout: Duration) -> Result<String, String>;
}

/// 未装配时拒绝，避免静默连上任意主机。
#[derive(Debug, Default, Clone, Copy)]
pub struct DisabledSsh;

impl SshExec for DisabledSsh {
    fn exec(
        &self,
        _connection_id: &str,
        _command: &str,
        _timeout: Duration,
    ) -> Result<String, String> {
        Err("ssh.exec 未装配".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{enter_injected_connection, injected_connection};

    #[test]
    fn plugin_supplied_id_does_not_replace_host_injection() {
        let _guard = enter_injected_connection(Some("conn-host".into()));
        let plugin_spec = r#"{"connectionId":"conn-plugin","command":"uname"}"#;
        let parsed: serde_json::Value = serde_json::from_str(plugin_spec).unwrap();
        assert_eq!(parsed["connectionId"], "conn-plugin");
        assert_eq!(injected_connection().as_deref(), Some("conn-host"));
    }

    #[test]
    fn empty_injection_is_absent() {
        let _guard = enter_injected_connection(Some("  ".into()));
        assert!(injected_connection().is_none());
    }
}
