//! 数据库危险操作：重启服务、删表、删库（必须消费 presence token）。

use omnipanel_error::{OmniError, OmniResult};
use omnipanel_presence::{
    ACTION_DB_DROP_DATABASE, ACTION_DB_DROP_TABLE, ACTION_DB_RESTART, drop_database_target,
    drop_table_objects_target, require_grant, restart_target,
};
use omnipanel_store::{AuditEntry, DbConnectionConfig};
use serde::Deserialize;
use specta::Type;
use tauri::State;

use crate::commands::ssh::pool_session;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbDropObject {
    pub database: String,
    pub name: String,
    pub kind: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn append_danger_audit(
    state: &AppState,
    action: &str,
    target: &str,
    status: &str,
    detail: &str,
) {
    let entry = AuditEntry {
        ts: now_ms(),
        action: action.into(),
        target: target.into(),
        env_tag: "unknown".into(),
        risk: "critical".into(),
        status: status.into(),
        detail: detail.into(),
    };
    if let Ok(store) = state.storage.try_lock() {
        let _ = store.append_audit(&entry);
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

fn host_mysql_restart() -> String {
    [
        "if command -v systemctl >/dev/null 2>&1; then",
        "for u in mysql mysqld mariadb; do",
        r#"if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl restart "$u" && exit 0; fi;"#,
        "done;",
        "fi;",
        "if command -v service >/dev/null 2>&1; then",
        r#"for u in mysql mysqld mariadb; do service "$u" restart 2>/dev/null && exit 0; done;"#,
        "fi;",
        "exit 1",
    ]
    .join(" ")
}

fn host_redis_restart() -> String {
    [
        "if command -v systemctl >/dev/null 2>&1; then",
        "for u in redis redis-server; do",
        r#"if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl restart "$u" && exit 0; fi;"#,
        "done;",
        "fi;",
        "if command -v service >/dev/null 2>&1; then",
        r#"for u in redis redis-server; do service "$u" restart 2>/dev/null && exit 0; done;"#,
        "fi;",
        "exit 1",
    ]
    .join(" ")
}

#[tauri::command]
#[specta::specta]
pub async fn db_restart_service(
    state: State<'_, AppState>,
    ssh_connection_id: String,
    service: String,
    kind: String,
    location: String,
    presence_token: String,
) -> Result<(), OmniError> {
    let target = restart_target(&ssh_connection_id, &service, &kind, &location);
    if let Err(e) = require_grant(
        &state.presence_tokens,
        Some(&presence_token),
        ACTION_DB_RESTART,
        &target,
    ) {
        append_danger_audit(&state, ACTION_DB_RESTART, &target, "blocked", "token 无效");
        return Err(e);
    }

    let command = if kind == "docker" {
        if location.trim().is_empty() {
            return Err(OmniError::invalid_input("缺少容器"));
        }
        format!("docker restart {}", shell_quote(&location))
    } else if kind == "host" {
        match service.as_str() {
            "mysql" => host_mysql_restart(),
            "redis" => host_redis_restart(),
            _ => return Err(OmniError::invalid_input("不支持的数据库服务")),
        }
    } else {
        return Err(OmniError::invalid_input("不支持的部署类型"));
    };

    let session = pool_session(&state, &ssh_connection_id).await?;
    let output = session.exec_capture(&command).await?;
    if output.exit_code != 0 {
        append_danger_audit(
            &state,
            ACTION_DB_RESTART,
            &target,
            "failed",
            "重启命令失败",
        );
        return Err(OmniError::ssh(format!(
            "重启失败: {}",
            output.stderr.trim()
        )));
    }
    append_danger_audit(&state, ACTION_DB_RESTART, &target, "success", "verified");
    Ok(())
}

pub(crate) fn quote_ident(engine: &str, name: &str) -> String {
    match engine {
        "mysql" | "hive" => format!("`{}`", name.replace('`', "``")),
        "mssql" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub(crate) fn normalize_drop_engine(db_type: &str) -> &'static str {
    let t = db_type.to_ascii_lowercase();
    if t.contains("postgres") || t.contains("highgo") || t.contains("kingbase") {
        "postgres"
    } else if t.contains("sqlite") {
        "sqlite"
    } else if t.contains("mssql") || t.contains("sqlserver") {
        "mssql"
    } else if t.contains("oracle") {
        "oracle"
    } else if t.contains("hive") {
        "hive"
    } else {
        "mysql"
    }
}

pub(crate) fn build_drop_table_sql(db_type: &str, database: &str, table: &str, view: bool) -> String {
    let engine = normalize_drop_engine(db_type);
    let verb = if view { "VIEW" } else { "TABLE" };
    let db = database.trim();
    let name = table.trim();
    match engine {
        "postgres" => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, "public"),
            quote_ident(engine, name)
        ),
        "sqlite" => format!("DROP {verb} {}", quote_ident(engine, name)),
        "mssql" => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, "dbo"),
            quote_ident(engine, name)
        ),
        "oracle" => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, db),
            quote_ident(engine, name)
        ),
        _ => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, db),
            quote_ident(engine, name)
        ),
    }
}

pub(crate) fn build_drop_database_sql(db_type: &str, database: &str) -> OmniResult<String> {
    let engine = normalize_drop_engine(db_type);
    let name = database.trim();
    if name.is_empty() {
        return Err(OmniError::invalid_input("数据库名为空"));
    }
    Ok(format!("DROP DATABASE {}", quote_ident(engine, name)))
}

fn drop_table_grant_target(connection_id: &str, objects: &[DbDropObject]) -> String {
    let pairs: Vec<(&str, &str)> = objects
        .iter()
        .map(|o| (o.database.as_str(), o.name.as_str()))
        .collect();
    drop_table_objects_target(connection_id, &pairs)
}

#[tauri::command]
#[specta::specta]
pub async fn db_drop_table(
    state: State<'_, AppState>,
    connection: DbConnectionConfig,
    objects: Vec<DbDropObject>,
    presence_token: String,
) -> Result<(), OmniError> {
    if objects.is_empty() {
        return Err(OmniError::invalid_input("未指定要删除的表"));
    }
    let target = drop_table_grant_target(&connection.id, &objects);
    if let Err(e) = require_grant(
        &state.presence_tokens,
        Some(&presence_token),
        ACTION_DB_DROP_TABLE,
        &target,
    ) {
        append_danger_audit(&state, ACTION_DB_DROP_TABLE, &target, "blocked", "token 无效");
        return Err(e);
    }

    for object in &objects {
        let sql = build_drop_table_sql(
            &connection.db_type,
            &object.database,
            &object.name,
            object.kind.eq_ignore_ascii_case("view"),
        );
        let mut conn = connection.clone();
        if !object.database.trim().is_empty() {
            conn.database = object.database.clone();
        }
        let params = crate::commands::database::to_params(&conn);
        let driver = omnipanel_db::connect(&params)
            .await
            .map_err(|e| OmniError::database(e.to_string()))?;
        driver
            .execute(&sql)
            .await
            .map_err(|e| OmniError::database(e.to_string()))?;
    }
    append_danger_audit(&state, ACTION_DB_DROP_TABLE, &target, "success", "verified");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn db_drop_database(
    state: State<'_, AppState>,
    connection: DbConnectionConfig,
    databases: Vec<String>,
    presence_token: String,
) -> Result<(), OmniError> {
    let mut names: Vec<String> = databases
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err(OmniError::invalid_input("未指定要删除的数据库"));
    }
    let joined = names.join(",");
    let target = drop_database_target(&connection.id, &joined);
    if let Err(e) = require_grant(
        &state.presence_tokens,
        Some(&presence_token),
        ACTION_DB_DROP_DATABASE,
        &target,
    ) {
        append_danger_audit(
            &state,
            ACTION_DB_DROP_DATABASE,
            &target,
            "blocked",
            "token 无效",
        );
        return Err(e);
    }

    for name in &names {
        let sql = build_drop_database_sql(&connection.db_type, name)?;
        let params = crate::commands::database::to_params(&connection);
        let driver = omnipanel_db::connect(&params)
            .await
            .map_err(|e| OmniError::database(e.to_string()))?;
        driver
            .execute(&sql)
            .await
            .map_err(|e| OmniError::database(e.to_string()))?;
    }
    append_danger_audit(
        &state,
        ACTION_DB_DROP_DATABASE,
        &target,
        "success",
        "verified",
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use omnipanel_presence::{
        ACTION_DB_DROP_DATABASE, ACTION_DB_DROP_TABLE, ACTION_DB_RESTART, TokenStore,
        drop_database_target, drop_table_objects_target, require_grant, restart_target,
    };

    use super::*;

    #[test]
    fn restart_without_token_rejected() {
        let store = TokenStore::system();
        let target = restart_target("ssh1", "mysql", "host", "srv");
        assert!(require_grant(&store, None, ACTION_DB_RESTART, &target).is_err());
        assert!(require_grant(&store, Some("nope"), ACTION_DB_RESTART, &target).is_err());
    }

    #[test]
    fn drop_without_token_rejected() {
        let store = TokenStore::system();
        let target = drop_table_objects_target("c1", &[("db", "users")]);
        assert!(require_grant(&store, None, ACTION_DB_DROP_TABLE, &target).is_err());
        assert!(require_grant(&store, Some("nope"), ACTION_DB_DROP_TABLE, &target).is_err());
        let db_target = drop_database_target("c1", "sales");
        assert!(require_grant(&store, None, ACTION_DB_DROP_DATABASE, &db_target).is_err());
    }

    #[test]
    fn drop_sql_mysql_table() {
        let sql = build_drop_table_sql("mysql", "app", "users", false);
        assert_eq!(sql, "DROP TABLE `app`.`users`");
        let view = build_drop_table_sql("mysql", "app", "v1", true);
        assert_eq!(view, "DROP VIEW `app`.`v1`");
    }

    #[test]
    fn drop_database_sql() {
        assert_eq!(
            build_drop_database_sql("postgres", "sales").unwrap(),
            "DROP DATABASE \"sales\""
        );
    }
}
