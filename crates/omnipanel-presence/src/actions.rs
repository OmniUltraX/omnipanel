use omnipanel_error::{OmniError, OmniResult};

pub const ACTION_DB_RESTART: &str = "db.service.restart";
pub const ACTION_DB_DROP_TABLE: &str = "db.schema.drop_table";
pub const ACTION_DB_DROP_DATABASE: &str = "db.schema.drop_database";
pub const ACTION_DB_DROP_USER: &str = "db.user.drop";
pub const ACTION_DB_ALTER_DROP: &str = "db.schema.alter_drop";
pub const ACTION_DB_TRUNCATE: &str = "db.sql.truncate";
pub const ACTION_DB_FLUSH: &str = "db.redis.flush";
pub const ACTION_DB_KILL: &str = "db.session.kill";
pub const ACTION_DOCKER_ENGINE_RESTART: &str = "docker.engine.restart";
pub const ACTION_DOCKER_CONTAINER_REMOVE: &str = "docker.container.remove";
pub const ACTION_DOCKER_COMPOSE_DOWN: &str = "docker.compose.down";
pub const ACTION_DOCKER_VOLUME_REMOVE: &str = "docker.volume.remove";
pub const ACTION_DOCKER_IMAGE_REMOVE: &str = "docker.image.remove";
pub const ACTION_DOCKER_NETWORK_REMOVE: &str = "docker.network.remove";
pub const ACTION_CLOUD_LIFECYCLE: &str = "cloud.instance.lifecycle";
pub const ACTION_SSH_EXEC: &str = "ssh.exec";
pub const ACTION_SSH_KILL: &str = "ssh.process.kill";
pub const ACTION_PANEL_DELETE: &str = "panel.resource.delete";
pub const ACTION_FILES_DELETE: &str = "files.remote.delete";
pub const ACTION_AI_TOOL: &str = "ai.tool.write";
pub const ACTION_PLUGIN_HOST: &str = "plugin.host.privileged";
pub const TYPED_RESTART: &str = "RESTART";

pub fn pipe_target(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("|")
}

pub fn restart_target(ssh_id: &str, service: &str, kind: &str, location: &str) -> String {
    pipe_target(&[ssh_id, service, kind, location])
}

pub fn drop_table_target(connection_id: &str, database: &str, tables: &[&str]) -> String {
    let mut names: Vec<String> = tables
        .iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    names.sort();
    names.dedup();
    format!(
        "{}|{}|{}",
        connection_id.trim(),
        database.trim(),
        names.join(",")
    )
}

/// 单库：`{conn}|{db}|sorted,names`；跨库：`{conn}|*|{db.name,...}`。
pub fn drop_table_objects_target(connection_id: &str, objects: &[(&str, &str)]) -> String {
    let mut dbs: Vec<&str> = objects.iter().map(|(db, _)| db.trim()).collect();
    dbs.sort();
    dbs.dedup();
    if dbs.len() <= 1 {
        let names: Vec<&str> = objects.iter().map(|(_, name)| *name).collect();
        return drop_table_target(connection_id, dbs.first().copied().unwrap_or(""), &names);
    }
    let qualified: Vec<String> = objects
        .iter()
        .map(|(db, name)| format!("{}.{}", db.trim(), name.trim()))
        .collect();
    let refs: Vec<&str> = qualified.iter().map(String::as_str).collect();
    drop_table_target(connection_id, "*", &refs)
}

pub fn drop_database_target(connection_id: &str, database: &str) -> String {
    pipe_target(&[connection_id, database])
}

fn last_segment(target: &str) -> OmniResult<String> {
    let name = target.rsplit('|').next().unwrap_or("").trim();
    if name.is_empty() {
        return Err(OmniError::invalid_input("在场验证目标无效"));
    }
    Ok(name.to_string())
}

fn is_restart_action(action: &str) -> bool {
    action.ends_with(".restart") || action == ACTION_DOCKER_ENGINE_RESTART
}

/// 第一方 action，或插件 `plugin.*` 自定义写操作。
pub fn is_known_action(action: &str) -> bool {
    matches!(
        action,
        ACTION_DB_RESTART
            | ACTION_DB_DROP_TABLE
            | ACTION_DB_DROP_DATABASE
            | ACTION_DB_DROP_USER
            | ACTION_DB_ALTER_DROP
            | ACTION_DB_TRUNCATE
            | ACTION_DB_FLUSH
            | ACTION_DB_KILL
            | ACTION_DOCKER_ENGINE_RESTART
            | ACTION_DOCKER_CONTAINER_REMOVE
            | ACTION_DOCKER_COMPOSE_DOWN
            | ACTION_DOCKER_VOLUME_REMOVE
            | ACTION_DOCKER_IMAGE_REMOVE
            | ACTION_DOCKER_NETWORK_REMOVE
            | ACTION_CLOUD_LIFECYCLE
            | ACTION_SSH_EXEC
            | ACTION_SSH_KILL
            | ACTION_PANEL_DELETE
            | ACTION_FILES_DELETE
            | ACTION_AI_TOOL
            | ACTION_PLUGIN_HOST
    ) || action.starts_with("plugin.")
}

/// 打字签发：重启固定 RESTART；其余为 target 最后一段。
pub fn expected_typed(action: &str, target: &str) -> OmniResult<String> {
    if !is_known_action(action) {
        return Err(OmniError::invalid_input("不支持的在场验证动作"));
    }
    if is_restart_action(action) {
        return Ok(TYPED_RESTART.to_string());
    }
    last_segment(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_table_target_sorts_and_dedups() {
        let t = drop_table_target("c1", "db", &["b", "a", "a"]);
        assert_eq!(t, "c1|db|a,b");
        assert_eq!(expected_typed(ACTION_DB_DROP_TABLE, &t).unwrap(), "a,b");
    }

    #[test]
    fn drop_table_objects_cross_db() {
        let t = drop_table_objects_target("c1", &[("sales", "a"), ("hr", "b")]);
        assert_eq!(t, "c1|*|hr.b,sales.a");
    }

    #[test]
    fn restart_and_plugin_actions_typed() {
        assert_eq!(
            expected_typed(ACTION_DOCKER_ENGINE_RESTART, "c1|engine").unwrap(),
            "RESTART"
        );
        assert_eq!(
            expected_typed("plugin.omni.cloud.aliyun.stop", "i-1|stop").unwrap(),
            "stop"
        );
    }
}
