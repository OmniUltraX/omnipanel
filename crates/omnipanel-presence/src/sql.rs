use omnipanel_error::OmniResult;

use crate::actions::{
    ACTION_DB_ALTER_DROP, ACTION_DB_DROP_DATABASE, ACTION_DB_DROP_TABLE, ACTION_DB_DROP_USER,
    ACTION_DB_FLUSH, ACTION_DB_KILL, ACTION_DB_TRUNCATE, drop_database_target, drop_table_target,
    pipe_target,
};
use crate::token::TokenStore;
use crate::{presence_denied, require_grant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DangerousSql {
    None,
    DropTable { name: String },
    DropDatabase { name: String },
    DropUser { name: String },
    AlterDrop { name: String },
    Truncate { name: String },
    DeleteNoWhere { name: String },
    Flush { name: String },
    Kill { name: String },
    Multiple,
}

/// 识别脚本中的危险 DDL。多于一条危险语句视为 Multiple。
pub fn classify_sql(sql: &str) -> DangerousSql {
    let mut found: Vec<DangerousSql> = Vec::new();
    for raw in split_statements(sql) {
        if let Some(item) = classify_one(&raw) {
            found.push(item);
        }
    }
    match found.len() {
        0 => DangerousSql::None,
        1 => found.remove(0),
        _ => DangerousSql::Multiple,
    }
}

pub fn ensure_sql_presence(
    store: &TokenStore,
    sql: &str,
    connection_id: &str,
    database: &str,
    token: Option<&str>,
) -> OmniResult<Option<(String, String)>> {
    match classify_sql(sql) {
        DangerousSql::None => Ok(None),
        DangerousSql::Multiple => Err(presence_denied(
            "一次只能确认一条危险语句，请拆开执行",
        )),
        DangerousSql::DropTable { name } => {
            let db = if database.trim().is_empty() {
                infer_qualifier_db(sql).unwrap_or_default()
            } else {
                database.to_string()
            };
            let target = drop_table_target(connection_id, &db, &[&name]);
            require_grant(store, token, ACTION_DB_DROP_TABLE, &target)?;
            Ok(Some((ACTION_DB_DROP_TABLE.to_string(), target)))
        }
        DangerousSql::DropDatabase { name } => {
            let target = drop_database_target(connection_id, &name);
            require_grant(store, token, ACTION_DB_DROP_DATABASE, &target)?;
            Ok(Some((ACTION_DB_DROP_DATABASE.to_string(), target)))
        }
        DangerousSql::DropUser { name } => {
            let target = pipe_target(&[connection_id, &name]);
            require_grant(store, token, ACTION_DB_DROP_USER, &target)?;
            Ok(Some((ACTION_DB_DROP_USER.to_string(), target)))
        }
        DangerousSql::AlterDrop { name } => {
            let target = pipe_target(&[connection_id, database, &name]);
            require_grant(store, token, ACTION_DB_ALTER_DROP, &target)?;
            Ok(Some((ACTION_DB_ALTER_DROP.to_string(), target)))
        }
        DangerousSql::Truncate { name } | DangerousSql::DeleteNoWhere { name } => {
            let target = drop_table_target(connection_id, database, &[&name]);
            require_grant(store, token, ACTION_DB_TRUNCATE, &target)?;
            Ok(Some((ACTION_DB_TRUNCATE.to_string(), target)))
        }
        DangerousSql::Flush { name } => {
            let target = pipe_target(&[connection_id, &name]);
            require_grant(store, token, ACTION_DB_FLUSH, &target)?;
            Ok(Some((ACTION_DB_FLUSH.to_string(), target)))
        }
        DangerousSql::Kill { name } => {
            let target = pipe_target(&[connection_id, &name]);
            require_grant(store, token, ACTION_DB_KILL, &target)?;
            Ok(Some((ACTION_DB_KILL.to_string(), target)))
        }
    }
}

fn split_statements(sql: &str) -> Vec<String> {
    sql.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("--"))
        .map(str::to_string)
        .collect()
}

fn classify_one(stmt: &str) -> Option<DangerousSql> {
    let trimmed = strip_leading_comments(stmt);
    let upper = trimmed.to_ascii_uppercase();
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "DROP TABLE") {
        return Some(DangerousSql::DropTable {
            name: last_ident(&skip_if_exists(rest)),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "DROP DATABASE") {
        return Some(DangerousSql::DropDatabase {
            name: last_ident(&skip_if_exists(rest)),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "DROP SCHEMA") {
        return Some(DangerousSql::DropDatabase {
            name: last_ident(&skip_if_exists(rest)),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "DROP USER") {
        return Some(DangerousSql::DropUser {
            name: last_ident(&skip_if_exists(rest)),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "DROP INDEX") {
        return Some(DangerousSql::AlterDrop {
            name: last_ident(&skip_if_exists(rest)),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "TRUNCATE TABLE") {
        return Some(DangerousSql::Truncate {
            name: last_ident(&rest),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "TRUNCATE") {
        return Some(DangerousSql::Truncate {
            name: last_ident(&rest),
        });
    }
    if upper.starts_with("FLUSHALL") {
        return Some(DangerousSql::Flush {
            name: "FLUSHALL".into(),
        });
    }
    if upper.starts_with("FLUSHDB") {
        return Some(DangerousSql::Flush {
            name: "FLUSHDB".into(),
        });
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "DELETE FROM") {
        let name = last_ident(rest);
        let after_name = rest
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ");
        if !after_name.to_ascii_uppercase().contains("WHERE") {
            return Some(DangerousSql::DeleteNoWhere { name });
        }
    }
    if let Some(idx) = upper.find("DROP COLUMN") {
        let after = trimmed.get(idx + "DROP COLUMN".len()..).unwrap_or("");
        let name = last_ident(after.trim_start());
        if !name.is_empty() {
            return Some(DangerousSql::AlterDrop { name });
        }
    }
    if let Some(rest) = strip_prefix_ci(&upper, &trimmed, "KILL") {
        return Some(DangerousSql::Kill {
            name: last_ident(rest),
        });
    }
    if let Some(idx) = upper.find("PG_TERMINATE_BACKEND") {
        let after = &trimmed[idx..];
        let digits: String = after
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return Some(DangerousSql::Kill { name: digits });
        }
    }
    None
}

fn strip_leading_comments(stmt: &str) -> String {
    let mut s = stmt.trim_start();
    while s.starts_with("--") {
        s = s.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
        s = s.trim_start();
    }
    s.to_string()
}

fn strip_prefix_ci<'a>(upper: &str, original: &'a str, prefix: &str) -> Option<&'a str> {
    let p = prefix.len();
    if upper.starts_with(prefix)
        && original
            .get(p..)
            .map(|rest| rest.starts_with(|c: char| c.is_whitespace()) || rest.is_empty())
            .unwrap_or(false)
    {
        return Some(original[p..].trim_start());
    }
    None
}

fn skip_if_exists(rest: &str) -> String {
    let upper = rest.to_ascii_uppercase();
    if upper.starts_with("IF EXISTS") {
        rest[9..].trim_start().to_string()
    } else {
        rest.to_string()
    }
}

fn last_ident(name: &str) -> String {
    let cut = name
        .split_whitespace()
        .next()
        .unwrap_or(name)
        .trim_end_matches(',');
    cut.split('.')
        .next_back()
        .unwrap_or(cut)
        .trim_matches(['`', '"', '[', ']', '\'', ' ', '\t'])
        .to_string()
}

fn infer_qualifier_db(sql: &str) -> Option<String> {
    let stmt = split_statements(sql).into_iter().next()?;
    let trimmed = strip_leading_comments(&stmt);
    let upper = trimmed.to_ascii_uppercase();
    let rest = strip_prefix_ci(&upper, &trimmed, "DROP TABLE")?;
    let spec = skip_if_exists(rest);
    let first = spec.split_whitespace().next()?;
    let parts: Vec<&str> = first.split('.').collect();
    if parts.len() >= 2 {
        Some(
            parts[0]
                .trim_matches(['`', '"', '[', ']', '\'', ' '])
                .to_string(),
        )
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_select_as_none() {
        assert_eq!(classify_sql("SELECT 1"), DangerousSql::None);
    }

    #[test]
    fn classifies_drop_table() {
        assert_eq!(
            classify_sql("DROP TABLE `db`.`users`"),
            DangerousSql::DropTable {
                name: "users".into()
            }
        );
    }

    #[test]
    fn classifies_drop_database() {
        assert_eq!(
            classify_sql("DROP DATABASE IF EXISTS prod"),
            DangerousSql::DropDatabase { name: "prod".into() }
        );
    }

    #[test]
    fn multiple_drops_rejected() {
        assert_eq!(
            classify_sql("DROP TABLE a; DROP TABLE b"),
            DangerousSql::Multiple
        );
    }

    #[test]
    fn execute_drop_requires_token() {
        let store = TokenStore::system();
        assert!(
            ensure_sql_presence(&store, "DROP TABLE t", "c1", "db", None).is_err()
        );
        let target = drop_table_target("c1", "db", &["t"]);
        let issued = store.issue(ACTION_DB_DROP_TABLE, &target).unwrap();
        ensure_sql_presence(&store, "DROP TABLE t", "c1", "db", Some(&issued.token)).unwrap();
    }

    #[test]
    fn classifies_truncate_delete_user_kill() {
        assert_eq!(
            classify_sql("TRUNCATE TABLE logs"),
            DangerousSql::Truncate {
                name: "logs".into()
            }
        );
        assert_eq!(
            classify_sql("DELETE FROM logs"),
            DangerousSql::DeleteNoWhere {
                name: "logs".into()
            }
        );
        assert_eq!(
            classify_sql("DELETE FROM logs WHERE id=1"),
            DangerousSql::None
        );
        assert_eq!(
            classify_sql("DROP USER IF EXISTS alice"),
            DangerousSql::DropUser {
                name: "alice".into()
            }
        );
        assert_eq!(
            classify_sql("ALTER TABLE t DROP COLUMN age"),
            DangerousSql::AlterDrop { name: "age".into() }
        );
        assert_eq!(
            classify_sql("KILL 42"),
            DangerousSql::Kill { name: "42".into() }
        );
        assert_eq!(
            classify_sql("SELECT pg_terminate_backend(88)"),
            DangerousSql::Kill { name: "88".into() }
        );
        assert_eq!(
            classify_sql("FLUSHALL"),
            DangerousSql::Flush {
                name: "FLUSHALL".into()
            }
        );
    }
}
