use omnipanel_error::{OmniError, OmniResult};

pub const ACTION_DB_RESTART: &str = "db.service.restart";
pub const ACTION_DB_DROP_TABLE: &str = "db.schema.drop_table";
pub const ACTION_DB_DROP_DATABASE: &str = "db.schema.drop_database";
pub const TYPED_RESTART: &str = "RESTART";

pub fn restart_target(ssh_id: &str, service: &str, kind: &str, location: &str) -> String {
    format!(
        "{}|{}|{}|{}",
        ssh_id.trim(),
        service.trim(),
        kind.trim(),
        location.trim()
    )
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
    format!("{}|{}", connection_id.trim(), database.trim())
}

/// 打字签发的期望串：重启固定 RESTART；删表/删库为 target 最后一段。
pub fn expected_typed(action: &str, target: &str) -> OmniResult<String> {
    match action {
        ACTION_DB_RESTART => Ok(TYPED_RESTART.to_string()),
        ACTION_DB_DROP_TABLE | ACTION_DB_DROP_DATABASE => {
            let name = target.rsplit('|').next().unwrap_or("").trim();
            if name.is_empty() {
                return Err(OmniError::invalid_input("在场验证目标无效"));
            }
            Ok(name.to_string())
        }
        _ => Err(OmniError::invalid_input("不支持的在场验证动作")),
    }
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
}
