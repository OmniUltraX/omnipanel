use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{OmniError, OmniResult};
use serde::Serialize;
use specta::Type;

use crate::presence_denied;

pub const TOKEN_TTL_MS: u64 = 120_000;
/// 一次在场确认后，同一 action+target 可再签发的短时额度（覆盖分片执行）。
pub const LEASE_TTL_MS: u64 = 15 * 60 * 1000;
pub const LEASE_BUDGET: u32 = 256;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PresenceTokenIssued {
    pub token: String,
    pub expires_at_ms: u64,
    pub action: String,
    pub target: String,
}

struct Grant {
    action: String,
    target: String,
    expires_at_ms: u64,
}

struct Lease {
    expires_at_ms: u64,
    remaining: u32,
}

pub struct TokenStore {
    grants: Mutex<HashMap<String, Grant>>,
    leases: Mutex<HashMap<String, Lease>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for TokenStore {
    fn default() -> Self {
        Self::system()
    }
}

impl TokenStore {
    pub fn system() -> Self {
        Self {
            grants: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
            clock: Arc::new(now_unix_ms),
        }
    }

    pub fn with_clock(clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            grants: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
            clock: Arc::new(clock),
        }
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    pub fn issue(&self, action: &str, target: &str) -> OmniResult<PresenceTokenIssued> {
        if action.trim().is_empty() || target.trim().is_empty() {
            return Err(OmniError::invalid_input("在场验证 action/target 不能为空"));
        }
        let token = random_hex_32()?;
        let expires_at_ms = self.now().saturating_add(TOKEN_TTL_MS);
        let issued = PresenceTokenIssued {
            token: token.clone(),
            expires_at_ms,
            action: action.to_string(),
            target: target.to_string(),
        };
        self.grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                token,
                Grant {
                    action: action.to_string(),
                    target: target.to_string(),
                    expires_at_ms,
                },
            );
        Ok(issued)
    }

    /// 用户刚完成一次在场确认后，允许同一 action+target 在额度内再签发，避免分片任务反复弹验证。
    pub fn open_lease(&self, action: &str, target: &str) {
        if action.trim().is_empty() || target.trim().is_empty() {
            return;
        }
        let expires_at_ms = self.now().saturating_add(LEASE_TTL_MS);
        self.leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                lease_key(action, target),
                Lease {
                    expires_at_ms,
                    remaining: LEASE_BUDGET,
                },
            );
    }

    pub fn issue_under_lease(&self, action: &str, target: &str) -> OmniResult<PresenceTokenIssued> {
        let now = self.now();
        {
            let mut map = self.leases.lock().unwrap_or_else(|e| e.into_inner());
            let key = lease_key(action, target);
            let Some(lease) = map.get_mut(&key) else {
                return Err(presence_denied("在场验证已失效，请重新确认"));
            };
            if now > lease.expires_at_ms || lease.remaining == 0 {
                map.remove(&key);
                return Err(presence_denied("在场验证已过期，请重新确认"));
            }
            lease.remaining = lease.remaining.saturating_sub(1);
            if lease.remaining == 0 {
                map.remove(&key);
            }
        }
        self.issue(action, target)
    }

    pub fn consume(&self, token: &str, action: &str, target: &str) -> OmniResult<()> {
        let now = self.now();
        let mut map = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let Some(grant) = map.remove(token) else {
            return Err(presence_denied("在场验证已失效或无效"));
        };
        if now > grant.expires_at_ms {
            return Err(presence_denied("在场验证已过期"));
        }
        if grant.action != action || grant.target != target {
            return Err(presence_denied("在场验证与当前操作不匹配"));
        }
        Ok(())
    }
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lease_key(action: &str, target: &str) -> String {
    format!("{action}\n{target}")
}

fn random_hex_32() -> OmniResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| OmniError::internal(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::require_grant;

    fn store_at(ms: u64) -> (TokenStore, Arc<AtomicU64>) {
        let clock = Arc::new(AtomicU64::new(ms));
        let moved = clock.clone();
        let store = TokenStore::with_clock(move || moved.load(Ordering::SeqCst));
        (store, clock)
    }

    #[test]
    fn consume_ok_then_reuse_fails() {
        let (store, _) = store_at(1_000);
        let issued = store
            .issue("db.service.restart", "ssh|mysql|host|a")
            .unwrap();
        require_grant(
            &store,
            Some(&issued.token),
            "db.service.restart",
            "ssh|mysql|host|a",
        )
        .unwrap();
        let err = require_grant(
            &store,
            Some(&issued.token),
            "db.service.restart",
            "ssh|mysql|host|a",
        )
        .unwrap_err();
        assert!(err.message.contains("失效") || err.message.contains("无效"));
    }

    #[test]
    fn wrong_action_or_target_rejected() {
        let (store, _) = store_at(1_000);
        let issued = store.issue("db.service.restart", "t1").unwrap();
        assert!(
            require_grant(&store, Some(&issued.token), "db.schema.drop_database", "t1",).is_err()
        );
        let issued = store.issue("db.service.restart", "t1").unwrap();
        assert!(require_grant(&store, Some(&issued.token), "db.service.restart", "t2").is_err());
    }

    #[test]
    fn expired_rejected() {
        let (store, clock) = store_at(1_000);
        let issued = store.issue("db.service.restart", "t1").unwrap();
        clock.store(1_000 + TOKEN_TTL_MS + 1, Ordering::SeqCst);
        assert!(require_grant(&store, Some(&issued.token), "db.service.restart", "t1").is_err());
    }

    #[test]
    fn lease_reissues_then_expires() {
        let (store, clock) = store_at(1_000);
        store.open_lease("ssh.exec", "host|rm");
        let first = store.issue_under_lease("ssh.exec", "host|rm").unwrap();
        require_grant(&store, Some(&first.token), "ssh.exec", "host|rm").unwrap();
        assert!(store.issue_under_lease("ssh.exec", "other|rm").is_err());
        clock.store(1_000 + LEASE_TTL_MS + 1, Ordering::SeqCst);
        assert!(store.issue_under_lease("ssh.exec", "host|rm").is_err());
    }

    #[test]
    fn missing_token_rejected() {
        let store = TokenStore::system();
        assert!(require_grant(&store, None, "db.service.restart", "t").is_err());
        assert!(require_grant(&store, Some("  "), "db.service.restart", "t").is_err());
    }
}
