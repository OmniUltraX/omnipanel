//! 引擎插件启用门禁。
//!
//! 第一方数据库引擎不可关闭，建连路径不再查询本门禁。
//! 仅第三方安装的 `kind=engine` 插件写入禁用集合。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};

use crate::engine_contract::FirstPartyEngine;

fn disabled_engine_plugins() -> &'static Mutex<Option<HashSet<String>>> {
    static CELL: OnceLock<Mutex<Option<HashSet<String>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// 安装门禁。`ids` 为当前禁用（或未激活）的引擎插件 id。
pub fn set_disabled_engine_plugins(ids: impl IntoIterator<Item = impl Into<String>>) {
    *disabled_engine_plugins()
        .lock()
        .expect("engine plugin gate") = Some(ids.into_iter().map(Into::into).collect());
}

/// 纯函数：未安装门禁则放行；已安装则只有不在禁用集合里的 plugin_id 可通过。
pub fn engine_plugin_allowed_in(disabled: Option<&HashSet<String>>, plugin_id: &str) -> bool {
    match disabled {
        None => true,
        Some(set) => !set.contains(plugin_id),
    }
}

pub fn engine_plugin_allowed(plugin_id: &str) -> bool {
    let guard = disabled_engine_plugins()
        .lock()
        .expect("engine plugin gate");
    engine_plugin_allowed_in(guard.as_ref(), plugin_id)
}

pub fn reject_if_engine_plugin_disabled(plugin_id: &str) -> OmniResult<()> {
    if engine_plugin_allowed(plugin_id) {
        Ok(())
    } else {
        Err(OmniError::new(
            ErrorCode::Permission,
            format!("引擎插件已禁用（{plugin_id}）"),
        ))
    }
}

pub fn gated_plugin_id(db_type: &str) -> Option<&'static str> {
    FirstPartyEngine::from_db_type(db_type).map(FirstPartyEngine::plugin_id)
}

/// 第一方引擎始终可用，建连热路径不要调用本函数。
/// 仅给第三方安装的 engine 插件预留。
pub fn reject_if_params_plugin_disabled(db_type: &str) -> OmniResult<()> {
    let Some(plugin_id) = gated_plugin_id(db_type) else {
        return Ok(());
    };
    if FirstPartyEngine::from_plugin_id(plugin_id).is_some() {
        return Ok(());
    }
    reject_if_engine_plugin_disabled(plugin_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_gate_allows() {
        assert!(engine_plugin_allowed_in(None, "omni.engine.mongodb"));
    }

    #[test]
    fn disabled_set_rejects_only_listed() {
        let set: HashSet<String> = ["omni.engine.mongodb".into()].into();
        assert!(!engine_plugin_allowed_in(Some(&set), "omni.engine.mongodb"));
        assert!(engine_plugin_allowed_in(Some(&set), "omni.engine.redis"));
    }

    #[test]
    fn gated_plugin_id_covers_all_first_party_engines() {
        assert_eq!(gated_plugin_id("mongodb"), Some("omni.engine.mongodb"));
        assert_eq!(gated_plugin_id("mongo"), Some("omni.engine.mongodb"));
        assert_eq!(gated_plugin_id("redis"), Some("omni.engine.redis"));
        assert_eq!(
            gated_plugin_id("clickhouse"),
            Some("omni.engine.clickhouse")
        );
        assert_eq!(gated_plugin_id("qdrant"), Some("omni.engine.qdrant"));
        assert_eq!(gated_plugin_id("mysql"), Some("omni.engine.mysql"));
        assert_eq!(gated_plugin_id("mariadb"), Some("omni.engine.mysql"));
        assert_eq!(gated_plugin_id("postgres"), Some("omni.engine.postgres"));
        assert_eq!(gated_plugin_id("postgresql"), Some("omni.engine.postgres"));
        assert_eq!(gated_plugin_id("sqlite"), Some("omni.engine.sqlite"));
        assert_eq!(gated_plugin_id("sqlserver"), Some("omni.engine.sqlserver"));
        assert_eq!(gated_plugin_id("mssql"), Some("omni.engine.sqlserver"));
        assert_eq!(gated_plugin_id("oracle"), None);
    }

    #[test]
    fn first_party_connect_skips_disable_set() {
        assert!(reject_if_params_plugin_disabled("mysql").is_ok());
        assert!(reject_if_params_plugin_disabled("redis").is_ok());
    }
}
